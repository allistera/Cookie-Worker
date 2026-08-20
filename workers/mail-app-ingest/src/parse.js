import PostalMime from 'postal-mime';
import { syntheticMessageId } from './synthetic-id.js';

export const BODY_CAP_BYTES = 512 * 1024;
export const SNIPPET_LENGTH = 100;
export const MAX_HEADERS = 100;
export const MAX_HEADER_VALUE = 2048;
export const MAX_ATTACHMENTS_META = 100;
export const MAX_REFERENCES = 50;
export const MAX_MESSAGE_ID = 998;
export const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * @param {ForwardableEmailMessage | {from?: string, to?: string, raw: string | ArrayBuffer | ReadableStream, rawSize?: number}} message
 */
export async function parseEmail(message) {
  const parsed = await PostalMime.parse(message.raw);
  const envelopeFrom = stripNul(message.from ?? '');
  const envelopeTo = stripNul(message.to ?? '');
  const headers = normalizeHeaders(parsed.headers);

  const rawText = stripNul(parsed.text ?? '');
  const rawHtml = stripNul(parsed.html ?? '');
  // Cap HTML before the regex stripper so a multi-megabyte HTML-only
  // message cannot pin CPU on nested tag rewrites.
  const htmlForText = capString(rawHtml, BODY_CAP_BYTES).value;
  const textSource = rawText || htmlToText(htmlForText);
  const textCap = capString(textSource, BODY_CAP_BYTES);
  const htmlCap = capString(rawHtml, BODY_CAP_BYTES);
  const sentAt = normalizeSentAt(parsed.date);
  const fromList = flattenAddresses(parsed.from);
  const from = fromList[0] ?? { name: null, address: envelopeFrom };
  const references = extractReferences(headers);
  const messageId = await normalizeMessageId(parsed.messageId, headers, {
    from: envelopeFrom,
    to: envelopeTo,
    date: parsed.date ?? '',
    subject: stripNul(parsed.subject ?? ''),
    bodyPrefix: (textSource || rawHtml).slice(0, 1024),
  });

  return {
    messageId,
    references,
    fromName: from.name,
    fromAddress: from.address || envelopeFrom,
    recipients: {
      to: flattenAddresses(parsed.to),
      cc: flattenAddresses(parsed.cc),
      bcc: flattenAddresses(parsed.bcc),
    },
    subject: stripNul(parsed.subject ?? ''),
    snippet: makeSnippet(textCap.value),
    bodyText: textCap.value,
    bodyHtml: htmlCap.value || null,
    sentAt,
    headers,
    attachments: normalizeAttachments(parsed.attachments ?? []),
    rawSize: message.rawSize ?? rawByteLength(message.raw),
    truncated: textCap.truncated || htmlCap.truncated,
    envelopeFrom,
    envelopeTo,
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stripNul(value) {
  return String(value ?? '').replaceAll('\0', '');
}

/**
 * @param {string} value
 * @param {number} maxBytes
 */
export function capString(value, maxBytes) {
  const clean = stripNul(value);
  const bytes = encoder.encode(clean);
  if (bytes.byteLength <= maxBytes) {
    return { value: clean, truncated: false };
  }
  return {
    value: decoder.decode(bytes.slice(0, maxBytes)).replace(/\uFFFD+$/u, ''),
    truncated: true,
  };
}

/**
 * @param {string} html
 */
export function htmlToText(html) {
  return stripNul(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/giu, '\n\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&quot;/giu, '"')
    .replace(/[ \t\f\v]+/gu, ' ')
    .replace(/\s*\n\s*/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * @param {unknown} dateValue
 */
function normalizeSentAt(dateValue) {
  const now = new Date();
  const parsed = dateValue ? new Date(String(dateValue)) : now;
  const valid = Number.isFinite(parsed.getTime()) ? parsed : now;
  return valid.getTime() - now.getTime() > MAX_FUTURE_MS ? now : valid;
}

/**
 * @param {unknown} entries
 * @returns {{name: string | null, address: string}[]}
 */
function flattenAddresses(entries) {
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    if ('group' in entry && Array.isArray(entry.group)) {
      return flattenAddresses(entry.group);
    }
    const address = stripNul('address' in entry ? entry.address : '');
    if (!address) return [];
    const name = stripNul('name' in entry ? entry.name : '');
    return [{ name: name || null, address }];
  });
}

/**
 * @param {unknown} headers
 * @returns {{key: string, value: string}[]}
 */
function normalizeHeaders(headers) {
  const entries = [];
  if (headers instanceof Map) {
    for (const [key, value] of headers) entries.push({ key, value });
  } else if (Array.isArray(headers)) {
    for (const item of headers) {
      if (Array.isArray(item)) entries.push({ key: item[0], value: item[1] });
      else if (item && typeof item === 'object') entries.push(item);
    }
  } else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) entries.push({ key, value });
  }
  return entries.slice(0, MAX_HEADERS).map((entry) => ({
    key: stripNul('key' in entry ? entry.key : entry.name).slice(0, MAX_HEADER_VALUE),
    value: stripNul('value' in entry ? entry.value : '').slice(0, MAX_HEADER_VALUE),
  }));
}

/**
 * Canonical Message-ID form used for storage and threading: `<id@host>`.
 * Bare ids, extra whitespace, and multi-token headers are normalized.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function canonicalizeMessageId(value) {
  const cleaned = stripNul(value).trim();
  if (!cleaned) return null;

  const bracketed = cleaned.match(/<([^<>]+)>/u);
  const id = (bracketed ? bracketed[1] : cleaned).replaceAll(/[<>]/gu, '').trim();
  if (!id) return null;

  const canonical = `<${id}>`;
  if (canonical.length > MAX_MESSAGE_ID) return null;
  return canonical;
}

/**
 * Split a References / In-Reply-To header into candidate tokens.
 * Prefers angle-bracketed ids; otherwise splits on whitespace.
 *
 * @param {string} headerValue
 * @returns {string[]}
 */
function extractReferenceTokens(headerValue) {
  const cleaned = stripNul(headerValue).trim();
  if (!cleaned) return [];
  const bracketed = cleaned.match(/<[^<>]+>/gu);
  if (bracketed) return bracketed;
  return cleaned.split(/\s+/u).filter(Boolean);
}

/**
 * @param {{key: string, value: string}[]} headers
 */
function extractReferences(headers) {
  const values = headers
    .filter((header) => ['references', 'in-reply-to'].includes(header.key.toLowerCase()))
    .flatMap((header) => extractReferenceTokens(header.value));
  const canonical = values
    .map((token) => canonicalizeMessageId(token))
    .filter((id) => id !== null);
  return [...new Set(canonical)].slice(0, MAX_REFERENCES);
}

/**
 * @param {unknown} messageId
 * @param {{key: string, value: string}[]} headers
 * @param {{from: string, to: string, date: string, subject: string, bodyPrefix: string}} fallback
 */
async function normalizeMessageId(messageId, headers, fallback) {
  const headerMessageId = stripNul(messageId)
    || stripNul(headers.find((header) => header.key.toLowerCase() === 'message-id')?.value ?? '');
  const canonical = canonicalizeMessageId(headerMessageId);
  if (canonical) return canonical;
  return syntheticMessageId(fallback);
}

/**
 * @param {string} value
 */
function makeSnippet(value) {
  const collapsed = stripNul(value).replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= SNIPPET_LENGTH) return collapsed;
  return `${collapsed.slice(0, SNIPPET_LENGTH)}...`;
}

/**
 * @param {unknown[]} attachments
 */
function normalizeAttachments(attachments) {
  return attachments.slice(0, MAX_ATTACHMENTS_META).map((attachment) => {
    const item = /** @type {{filename?: unknown, mimeType?: unknown, contentType?: unknown, content?: unknown}} */ (attachment);
    const content = attachmentContent(item.content);
    return {
      filename: item.filename === null || item.filename === undefined ? null : stripNul(item.filename),
      mime_type: stripNul(item.mimeType ?? item.contentType ?? ''),
      size: content.byteLength,
      content,
    };
  });
}

/**
 * @param {unknown} content
 */
function attachmentContent(content) {
  if (typeof content === 'string') return copyBytes(encoder.encode(content));
  if (content instanceof ArrayBuffer) return content;
  if (ArrayBuffer.isView(content)) {
    return copyBytes(new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
  }
  return new ArrayBuffer(0);
}

/**
 * @param {Uint8Array} bytes
 * @returns {ArrayBuffer}
 */
function copyBytes(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * @param {unknown} raw
 */
function rawByteLength(raw) {
  if (typeof raw === 'string') return encoder.encode(raw).byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  return 0;
}
