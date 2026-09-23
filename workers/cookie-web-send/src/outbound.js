// Ported from Cookie-Web's api/send.js — the immediate-send half. Behaviorally
// identical (same queries, validation, quota semantics, idempotency keys, and
// status codes), with two runtime translations: node:crypto's createHash
// becomes Web Crypto (so the idempotency key is now computed asynchronously)
// and Buffer.byteLength becomes TextEncoder. Meilisearch generates the
// semantic vector for sent mail itself once the message is indexed, so this
// no longer computes or stores an embedding at all.

import { Buffer } from 'node:buffer';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SNIPPET_LENGTH = 100;
export const MAX_OUTBOUND_RECIPIENTS = 20;
export const MAX_OUTBOUND_SUBJECT_BYTES = 998;
export const MAX_OUTBOUND_TEXT_BYTES = 100_000;
export const MAX_OUTBOUND_HTML_BYTES = 200_000;
export const MAX_OUTBOUND_TOTAL_BYTES = 256_000;
export const MAX_OUTBOUND_ATTACHMENTS = 20;
// Resend's 40 MB ceiling is measured after Base64 encoding, and Workers need
// headroom while converting streamed bytes into a provider-safe Base64 string.
export const MAX_OUTBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const OUTBOUND_SENDS_PER_MINUTE = 10;

/** @param {string} value */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// The pixel endpoint lives on the cookie-web-receipts Worker — a public
// identifier like Cookie-Web's apiWorkers.js URLs, not configuration. Unlike
// the Vercel handler this replaces, there is no "deployed environment" gate:
// this Worker only exists deployed (dev/e2e mail goes through fixtures), so
// every send gets a pixel.
const READ_RECEIPTS_PIXEL_BASE = 'https://receipts-api.infinitywave.online/read-receipts';

/** @param {string} token */
export function buildReadReceiptUrl(token) {
  if (!UUID_RE.test(token)) return null;
  const url = new URL(READ_RECEIPTS_PIXEL_BASE);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * @param {string | null} html
 * @param {string} text
 * @param {string | null} receiptUrl
 */
export function appendReadReceipt(html, text, receiptUrl) {
  if (!receiptUrl) return html;
  const content = html || escapeHtml(text).replaceAll('\n', '<br>');
  return `${content}<img src="${receiptUrl}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0" />`;
}

/** @param {string} text */
function makeSnippet(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > SNIPPET_LENGTH ? `${collapsed.slice(0, SNIPPET_LENGTH)}...` : collapsed;
}

/** @param {{EMAIL_FROM?: string}} env */
export function configuredEmailFrom(env) {
  const from = String(env.EMAIL_FROM || '').trim();
  if (!from) throw new Error('EMAIL_FROM is not configured');
  return from;
}

// "Name <addr@example.com>" -> { name, address }; bare address -> name null.
/** @param {string} from */
function parseFromEnv(from) {
  const match = /^(.*)<([^>]+)>\s*$/.exec(from);
  if (match) {
    return { name: match[1].trim() || null, address: match[2].trim() };
  }
  return { name: null, address: from.trim() };
}

// The "to" field is a comma-separated list of addresses; returns the trimmed,
// non-empty ones. Exported for testing.
// Longest representation a valid list can take: MAX_OUTBOUND_RECIPIENTS
// addresses of at most 320 chars, plus separators and generous whitespace.
// Enforced before split() so a multi-megabyte comma flood is rejected in O(1)
// instead of being expanded into millions of array entries first.
const MAX_RECIPIENTS_FIELD_CHARS = MAX_OUTBOUND_RECIPIENTS * 512;

/** @param {unknown} to */
export function parseRecipients(to) {
  if (!(/** @type {any} */ (to)?.split instanceof Function)) return [];
  if (String(to).length > MAX_RECIPIENTS_FIELD_CHARS) return [];
  const recipients = /** @type {string} */ (to)
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  if (recipients.length > MAX_OUTBOUND_RECIPIENTS) return [];
  return recipients;
}

/** @param {unknown} value */
export function parseAttachmentIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_OUTBOUND_ATTACHMENTS) return null;
  const ids = value.map((id) => String(id));
  if (ids.some((id) => !UUID_RE.test(id)) || new Set(ids).size !== ids.length) return null;
  return ids;
}

// Pragmatic RFC 5322 subset: one @, no whitespace or control characters, no
// header-significant punctuation, and a dotted domain. Resend would reject
// malformed values anyway, but rejecting here keeps CRLF/control-character
// payloads (classic SMTP header-injection shapes) out of the provider payload,
// the stored recipients column, and the scheduled-send queue.
const ADDRESS_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** @param {string} value */
function hasControlChars(value) {
  for (const character of value) {
    const code = /** @type {number} */ (character.codePointAt(0));
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** @param {string} address */
function validOutboundAddress(address) {
  return address.length <= 320 && ADDRESS_RE.test(address);
}

const byteLength = (/** @type {string} */ value) => new TextEncoder().encode(value).length;

/** @param {{to: unknown, subject: unknown, text: unknown, html: unknown}} message */
export function validateOutboundMessage({ to, subject, text, html }) {
  const recipients = parseRecipients(to);
  const htmlText = String(html ?? '');
  const bodyHtml = htmlText.trim() ? htmlText : null;
  const subjectText = String(subject ?? '');
  const bodyText = String(text ?? '');
  if (
    recipients.length === 0 ||
    !recipients.every(validOutboundAddress) ||
    !subjectText.trim() ||
    hasControlChars(subjectText) ||
    !bodyText.trim()
  ) {
    return { error: 'to, subject and text are required and must be valid' };
  }

  const subjectBytes = byteLength(subjectText);
  const textBytes = byteLength(bodyText);
  const htmlBytes = bodyHtml ? byteLength(bodyHtml) : 0;
  if (
    subjectBytes > MAX_OUTBOUND_SUBJECT_BYTES ||
    textBytes > MAX_OUTBOUND_TEXT_BYTES ||
    htmlBytes > MAX_OUTBOUND_HTML_BYTES ||
    subjectBytes + textBytes + htmlBytes > MAX_OUTBOUND_TOTAL_BYTES
  ) {
    return { error: 'The email exceeds the allowed content size' };
  }
  return { recipients, bodyHtml };
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function claimOutboundEmailQuota(sql, userId) {
  const [result] = await sql`
    WITH claimed AS (
      INSERT INTO outbound_email_quotas (user_id, window_start, send_count)
      VALUES (${userId}, date_trunc('minute', now()), 1)
      ON CONFLICT (user_id) DO UPDATE SET
        window_start = CASE
          WHEN outbound_email_quotas.window_start < date_trunc('minute', now())
            THEN EXCLUDED.window_start
          ELSE outbound_email_quotas.window_start
        END,
        send_count = CASE
          WHEN outbound_email_quotas.window_start < date_trunc('minute', now()) THEN 1
          ELSE outbound_email_quotas.send_count + 1
        END,
        updated_at = now()
      WHERE outbound_email_quotas.window_start < date_trunc('minute', now())
         OR outbound_email_quotas.send_count < ${OUTBOUND_SENDS_PER_MINUTE}
      RETURNING user_id
    )
    SELECT
      EXISTS (SELECT 1 FROM users WHERE id = ${userId}) AS authorized,
      EXISTS (SELECT 1 FROM claimed) AS quota_claimed
  `;
  return result || { authorized: false, quota_claimed: false };
}

// Compensating decrement after a failed provider delivery so an outage does
// not burn the user's per-minute allowance on mail that never went out. The
// window_start guard keeps the refund from leaking into a newer minute's
// counter after a rollover.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function refundOutboundEmailQuota(sql, userId) {
  try {
    await sql`
      UPDATE outbound_email_quotas
      SET send_count = GREATEST(send_count - 1, 0), updated_at = now()
      WHERE user_id = ${userId}
        AND window_start = date_trunc('minute', now())
        AND send_count > 0
    `;
  } catch (err) {
    console.error('failed to refund outbound email quota:', /** @type {Error} */ (err).message);
  }
}

// The content hash alone would silently dedupe a deliberate re-send of the
// identical message within the provider's idempotency window. Mixing in an
// optional client-generated requestId keeps double-click/retry protection
// (same requestId dedupes) while letting intentional duplicates through
// (new requestId, new send). Async because Web Crypto's digest is.
/**
 * @param {string} userId
 * @param {{recipients: string[], subject: unknown, text: unknown, html: unknown, replyToMessageId: string | null, attachmentIds?: string[], requestId: string | null}} message
 */
export async function immediateSendIdempotencyKey(
  userId,
  { recipients, subject, text, html, replyToMessageId, attachmentIds = [], requestId },
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      userId,
      recipients,
      subject,
      text,
      html: html ?? null,
      replyToMessageId: replyToMessageId ?? null,
      attachmentIds,
      requestId: requestId ?? null,
    }),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `immediate-send/${hex}`;
}

/** A retry must send byte-identical tracking HTML to the provider.
 * @param {string | undefined} idempotencyKey
 */
async function receiptTokenFor(idempotencyKey) {
  if (!idempotencyKey) return crypto.randomUUID();
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`receipt:${idempotencyKey}`)),
  );
  digest[6] = (digest[6] & 15) | 64;
  digest[8] = (digest[8] & 63) | 128;
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @param {unknown} value @param {string | number} [after] */
export function parseFollowUpAt(value, after = Date.now()) {
  const timestamp = Date.parse(String(value ?? ''));
  const afterTimestamp = new Date(after).getTime();
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(afterTimestamp) ||
    timestamp < Math.max(Date.now(), afterTimestamp) + 60_000
  )
    return null;
  return new Date(timestamp).toISOString();
}

/**
 * The seams the delivery path depends on, built once per request in
 * worker.js: createResend is injectable for tests, and the two index seams
 * hand a freshly stored sent copy to Meilisearch. Both are fire-and-forget —
 * worker.js owns the ExecutionContext and the connection the sync runs on, so
 * search indexing can never fail or delay a send.
 *
 * @typedef {{
 *   env: import('./sentry.js').SendEnv,
 *   createResend: (apiKey: string | undefined) => any,
 *   readBlob: (url: string) => Promise<{stream: ReadableStream<Uint8Array> | null} | null>,
 *   deleteBlob: (url: string) => Promise<unknown>,
 *   indexSentMessage: (messageUuid: string) => void,
 *   indexSentMessages: (messageUuids: string[]) => void,
 *   armScheduledSendClock?: (scheduledFor: string) => void,
 * }} SendServices
 */

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string[]} attachmentIds
 */
/** @param {unknown} err */
export function isUndefinedOutboundAttachmentsTable(err) {
  const error = /** @type {{code?: string, message?: string}} */ (err);
  return error?.code === '42P01' && /outbound_attachments/i.test(String(error.message ?? ''));
}

/**
 * Inbound attachments are owned through their message; composer uploads
 * (migration 0060) are owned directly. Both arrive as the same opaque id, so
 * resolve across the two and let callers treat them uniformly.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string[]} attachmentIds
 */
async function selectOwnedAttachmentRows(sql, userId, attachmentIds) {
  try {
    return await sql`
      SELECT * FROM (
        SELECT a.id, a.filename, a.content_type, a.size_bytes, a.blob_url,
               'inbound' AS source
        FROM attachments a
        JOIN messages m ON m.id = a.message_id
        WHERE a.id = ANY(${attachmentIds}::uuid[])
          AND m.user_id = ${userId}
          AND NOT m.is_deleted
          AND a.blob_url IS NOT NULL
        UNION ALL
        SELECT o.id, o.filename, o.content_type, o.size_bytes, o.blob_url,
               'upload' AS source
        FROM outbound_attachments o
        WHERE o.id = ANY(${attachmentIds}::uuid[])
          AND o.user_id = ${userId}
      ) owned
      ORDER BY array_position(${attachmentIds}::uuid[], owned.id)
    `;
  } catch (err) {
    // Rolling deploy: this release can run before migration 0060. Forwarded
    // attachments keep working; an upload id resolves to nothing and the send
    // is rejected as a missing attachment rather than delivered without it.
    if (!isUndefinedOutboundAttachmentsTable(err)) throw err;
    return sql`
      SELECT a.id, a.filename, a.content_type, a.size_bytes, a.blob_url,
             'inbound' AS source
      FROM attachments a
      JOIN messages m ON m.id = a.message_id
      WHERE a.id = ANY(${attachmentIds}::uuid[])
        AND m.user_id = ${userId}
        AND NOT m.is_deleted
        AND a.blob_url IS NOT NULL
      ORDER BY array_position(${attachmentIds}::uuid[], a.id)
    `;
  }
}

export async function resolveOwnedAttachments(sql, userId, attachmentIds) {
  if (attachmentIds.length === 0) return { attachments: [] };
  const rows = await selectOwnedAttachmentRows(sql, userId, attachmentIds);
  if (rows.length !== attachmentIds.length) return { missing: true };

  let declaredBytes = 0;
  for (const attachment of rows) {
    if (attachment.size_bytes === null || attachment.size_bytes === undefined) continue;
    const size = Number(attachment.size_bytes);
    if (!Number.isSafeInteger(size) || size < 0) return { invalid: true };
    declaredBytes += size;
  }
  if (declaredBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) return { tooLarge: true };
  return { attachments: rows };
}

/**
 * @param {any} attachment
 * @param {SendServices['readBlob']} readBlob
 */
async function readAttachmentContent(attachment, readBlob) {
  const result = await readBlob(attachment.blob_url);
  if (!result?.stream) throw new Error(`Attachment blob is unavailable: ${attachment.id}`);
  const reader = result.stream.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
        throw new Error('Outbound attachments exceed the provider size limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return {
    byteLength: bytes,
    providerAttachment: {
      content: Buffer.concat(chunks).toString('base64'),
      filename: attachment.filename || 'attachment',
      contentType: attachment.content_type || 'application/octet-stream',
    },
  };
}

/** @param {any[]} attachments @param {SendServices['readBlob']} readBlob */
async function loadProviderAttachments(attachments, readBlob) {
  const loaded = [];
  let totalBytes = 0;
  for (const attachment of attachments) {
    const loadedAttachment = await readAttachmentContent(attachment, readBlob);
    totalBytes += loadedAttachment.byteLength;
    if (totalBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      throw new Error('Outbound attachments exceed the provider size limit');
    }
    loaded.push(loadedAttachment.providerAttachment);
  }
  return loaded;
}

// Stores the sent copy in the existing tables (is_sent=true, excluded from
// the inbox list, included in search). Threads with the replied-to message
// when replyToMessageId is given; otherwise starts a fresh thread. Returns
// the new message's id so callers (e.g. the scheduled-send flush job) can
// link back to it, plus whether this call is the one that inserted it: a
// replayed send resolves to the same id but must not be re-indexed.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{recipients: string[], subject: string, text: string, html: string | null, replyToMessageId: string | null, resendId: string, readReceiptToken: string | null, attachments?: any[], followUpAt?: string | null}} message
 * @param {SendServices} services
 */
async function storeSentMessage(
  sql,
  userId,
  {
    recipients,
    subject,
    text,
    html,
    replyToMessageId,
    resendId,
    readReceiptToken,
    attachments = [],
    followUpAt,
  },
  services,
) {
  const messageId = resendId ? `<${resendId}@resend.cookie-web>` : null;
  const [lookup] = await sql`
    SELECT CASE WHEN ${replyToMessageId ?? null}::uuid IS NOT NULL THEN
             (SELECT m.thread_id FROM messages m
              WHERE m.id = ${replyToMessageId ?? null}::uuid AND m.user_id = ${userId})
           END AS thread_id,
           (SELECT m.id FROM messages m
            WHERE m.user_id = ${userId} AND m.message_id = ${messageId}
            LIMIT 1) AS existing_message_id
    FROM users u
    WHERE u.id = ${userId}
    LIMIT 1
  `;
  if (!lookup) {
    throw new Error('no users row matches the authenticated user; sent copy not stored');
  }

  const { name: fromName, address: fromAddress } = parseFromEnv(configuredEmailFrom(services.env));
  const messageUuid = lookup.existing_message_id ?? crypto.randomUUID();
  const threadUuid = lookup.thread_id ?? crypto.randomUUID();
  const sentAt = new Date().toISOString();
  const recipientsJson = JSON.stringify({
    to: recipients.map((address) => ({ name: null, address })),
    cc: [],
    bcc: [],
  });
  let inserted = false;
  if (!lookup.existing_message_id) {
    /** @type {Array<(sql: import('postgres').Sql | import('postgres').TransactionSql) => any>} */
    const statements = [];
    if (!lookup.thread_id) {
      statements.push(
        (sql) => sql`
        INSERT INTO threads (id, user_id, subject, last_message_at)
        VALUES (${threadUuid}, ${userId}, ${subject}, ${sentAt})
      `,
      );
    }
    // RETURNING makes the insert self-reporting: a row comes back only when
    // this call created it, so a concurrent send that won the ON CONFLICT race
    // is not mistaken for a fresh message.
    const messagesStatement = statements.length;
    statements.push(
      (sql) => sql`
      INSERT INTO messages (id, thread_id, user_id, from_name, from_address,
                            recipients, subject, snippet, body_text, body_html, sent_at,
                            message_id, is_unread, is_sent, follow_up_at)
      VALUES (${messageUuid}, ${threadUuid}, ${userId}, ${fromName},
              ${fromAddress}, ${recipientsJson}::jsonb, ${subject}, ${makeSnippet(text)},
              ${text}, ${html ?? null}, ${sentAt}, ${messageId}, false, true, ${followUpAt ?? null}::timestamptz)
      ON CONFLICT (user_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
      RETURNING id
    `,
    );
    if (lookup.thread_id) {
      statements.push(
        (sql) => sql`
        UPDATE threads
        SET message_count = message_count + 1,
            last_message_at = GREATEST(last_message_at, ${sentAt}::timestamptz)
        WHERE id = ${threadUuid}
          AND EXISTS (SELECT 1 FROM messages WHERE id = ${messageUuid})
      `,
      );
    }
    await sql.begin(async (sql) => {
      for (const [index, statement] of statements.entries()) {
        const result = await statement(sql);
        if (index === messagesStatement) inserted = result.length > 0;
      }
      if (inserted) {
        for (const attachment of attachments) {
          await sql`
            INSERT INTO attachments (message_id, filename, content_type, size_bytes, blob_url)
            VALUES (${messageUuid}, ${attachment.filename ?? null},
                    ${attachment.content_type ?? null}, ${attachment.size_bytes ?? null},
                    ${attachment.blob_url})
          `;
        }
      }
    });
  }

  // A retry repairs a sent copy whose first reminder write was interrupted.
  if (lookup.existing_message_id && followUpAt) {
    await sql`UPDATE messages SET follow_up_at = ${followUpAt}::timestamptz
      WHERE id = ${messageUuid} AND user_id = ${userId} AND is_sent`;
  }

  // Best effort and outside the sent-copy transaction: during a rolling
  // migration, a missing receipt table must not roll back the sent message.
  if (readReceiptToken) {
    try {
      await sql`
        INSERT INTO message_read_receipts (message_id, user_id, token)
        SELECT m.id, m.user_id, ${readReceiptToken}::uuid
        FROM messages m
        WHERE m.id = ${messageUuid} AND m.user_id = ${userId}
        ON CONFLICT (message_id) DO NOTHING
      `;
    } catch (err) {
      console.error('failed to store read receipt:', /** @type {Error} */ (err).message);
    }
  }

  return { messageUuid, inserted };
}

// Sends immediately through Resend, from the shared inbound handler (a
// logged-in user's request) and the flush job (a claimed scheduled row)
// alike. Throws on failure; callers decide how to react.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{recipients: string[], subject: string, text: string, html: string | null, replyToMessageId: string | null, idempotencyKey?: string, readReceiptToken?: string, attachments?: any[], followUpAt?: string | null}} message
 * @param {SendServices} services
 */
export async function deliverMail(
  sql,
  userId,
  {
    recipients,
    subject,
    text,
    html,
    replyToMessageId,
    idempotencyKey,
    readReceiptToken,
    attachments = [],
    followUpAt,
  },
  services,
) {
  const receiptToken = readReceiptToken ?? (await receiptTokenFor(idempotencyKey));
  const receiptUrl = buildReadReceiptUrl(receiptToken);
  const trackedHtml = appendReadReceipt(html, text, receiptUrl);

  const resend = services.createResend(services.env.RESEND_API_KEY);
  const providerAttachments = attachments.length
    ? await loadProviderAttachments(attachments, services.readBlob)
    : [];
  /** @type {Record<string, unknown>} */
  const payload = {
    from: configuredEmailFrom(services.env),
    to: recipients,
    subject,
    text,
  };
  if (trackedHtml) payload.html = trackedHtml;
  if (providerAttachments.length) payload.attachments = providerAttachments;
  const { data, error } = idempotencyKey
    ? await resend.emails.send(payload, { idempotencyKey })
    : await resend.emails.send(payload);
  if (error) throw new Error(error.message || 'Failed to send email');

  let messageUuid = null;
  // Only a real insert is new mail for the search index; a replay resolves to
  // an id that is already indexed (or already marked for the drift sweep).
  let inserted = false;
  try {
    ({ messageUuid, inserted } = await storeSentMessage(
      sql,
      userId,
      {
        recipients,
        subject,
        text,
        html,
        replyToMessageId,
        resendId: data.id,
        readReceiptToken: receiptUrl ? receiptToken : null,
        attachments,
        followUpAt,
      },
      services,
    ));
  } catch (err) {
    // Sending always wins: a storage failure is logged but the mail really
    // did go out, so this must never be treated as a failed send.
    console.error('failed to store sent copy:', /** @type {Error} */ (err).message);
  }
  return { resendId: data.id, messageUuid, inserted };
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string | null} replyToMessageId
 */
export async function ownedReplyToMessageId(sql, userId, replyToMessageId) {
  if (!replyToMessageId) return { replyTo: null };
  const [row] = await sql`
    SELECT m.id
    FROM messages m
    WHERE m.id = ${replyToMessageId}::uuid AND m.user_id = ${userId} AND NOT m.is_deleted
    LIMIT 1
  `;
  return row ? { replyTo: replyToMessageId } : { missing: true };
}
