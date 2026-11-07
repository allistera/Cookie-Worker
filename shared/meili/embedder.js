/**
 * Shared embedder settings. The model must match what the app embedded
 * before, so this migration changes where vectors come from and not which
 * model makes them.
 *
 * Its own module because both descriptors need it and meili.js re-exports
 * both descriptors: putting it in meili.js would be a cycle.
 */
export const EMBEDDER = {
  source: 'openAi',
  model: 'text-embedding-3-small',
  dimensions: 1536,
};

/**
 * A time as the chat model should read it ("2026-11-07 14:01 UTC"). Liquid's
 * `date` filter leaves the integer sent_at/updated_at fields untouched, so a
 * readable form has to be its own attribute; the model converts Unix seconds
 * badly and the person sees a wrong time in an answer. Empty when the row
 * has no time.
 *
 * @param {unknown} value a Date, ISO string or epoch milliseconds
 * @returns {string}
 */
export function readableTime(value) {
  if (!value) return '';
  const date = new Date(/** @type {any} */ (value));
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
