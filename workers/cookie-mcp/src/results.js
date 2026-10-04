import { ApiError } from './api.js';

export const TEXT_LIMIT = 20_000;

export class ToolInputError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/** @param {Record<string, unknown>} structured */
export function toolResult(structured) {
  return {
    structuredContent: structured,
    content: [{ type: /** @type {const} */ ('text'), text: JSON.stringify(structured) }],
  };
}

/** @param {string} text */
function failure(text) {
  return { isError: true, content: [{ type: /** @type {const} */ ('text'), text }] };
}

/** @param {unknown} error */
export function toolError(error) {
  if (error instanceof ToolInputError) return failure(`Invalid input: ${error.message}`);
  if (error instanceof ApiError) {
    const { status, message } = error;
    if (status === 401 || status === 403)
      return failure('This Cookie account is not provisioned for mailbox access.');
    if (status === 429)
      return failure(`Rate limited: ${message}. Wait about a minute before retrying.`);
    if (status === 404) return failure(`Not found: ${message}`);
    if (status === 409) return failure(`Conflict: ${message}`);
    if (status >= 400 && status < 500) return failure(`Invalid request: ${message}`);
    return failure(`Cookie could not complete the request (status ${status}). Try again later.`);
  }
  return failure('Cookie could not complete the request. Try again later.');
}

/** @param {string | null | undefined} value @param {number} [max] */
export function truncateText(value, max = TEXT_LIMIT) {
  const text = value ?? '';
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

const ENTITIES = /** @type {Record<string, string>} */ ({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  nbsp: ' ',
});

/** @param {string | null | undefined} html */
export function htmlToText(html) {
  return (html ?? '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ENTITIES[name])
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}
