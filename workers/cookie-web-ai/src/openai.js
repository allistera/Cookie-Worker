// The bits api/compose.js and api/summarize.js each carried their own copy of
// on Vercel — one Worker means one copy.

export { responsesUrl } from '../../../shared/openai.js';
export const DEFAULT_MODEL = 'gpt-5.6-luna';
export const RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/** @param {any} body */
export function outputText(body) {
  if (body?.output_text) return String(body.output_text);
  for (const item of body?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && content.text) return String(content.text);
    }
  }
  return '';
}

/** @param {unknown} value @param {number} max */
export function clean(value, max) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}
