// Ported from Cookie-Web's api/_lib/embeddings.js — already pure fetch(),
// no Node APIs. Not consolidated with mail-app-ingest's own embed.js: that
// one embeds a single fixed {subject, bodyText} record with a smaller
// (8000 char) input cap and no query cache, a genuinely different shape
// from this batch-capable, cache-backed client for free-text document
// search — see this repo's README ("shared root module only after at least
// two Workers actually use it").

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

// ~6k tokens, comfortably under the model's 8191-token input limit.
const MAX_INPUT_CHARS = 24000;

/**
 * Embeds one string; returns a 1536-number array. options.signal aborts the
 * request (e.g. AbortSignal.timeout(ms)) — used by document autosave so a
 * hung OpenAI call can't stall the serialized save queue indefinitely.
 *
 * @param {string} text
 * @param {string} apiKey
 * @param {{signal?: AbortSignal}} [options]
 */
export async function embedText(text, apiKey, options) {
  const [vector] = await embedBatch([text], apiKey, options);
  return vector;
}

// LRU-cached variant for user queries: repeat searches (retries, re-submits,
// back-navigation) skip the OpenAI round-trip and its cost. Per-isolate
// cache, cleared whenever the Worker's isolate recycles.
const queryCache = new Map();
const QUERY_CACHE_MAX = 200;

/**
 * @param {string} text
 * @param {string} apiKey
 */
export async function embedTextCached(text, apiKey) {
  if (queryCache.has(text)) {
    const vector = queryCache.get(text);
    queryCache.delete(text);
    queryCache.set(text, vector); // refresh recency
    return vector;
  }
  const vector = await embedText(text, apiKey, { signal: AbortSignal.timeout(8000) });
  queryCache.set(text, vector);
  if (queryCache.size > QUERY_CACHE_MAX) {
    queryCache.delete(queryCache.keys().next().value);
  }
  return vector;
}

/**
 * Embeds several strings in one API call; returns arrays in input order.
 *
 * @param {string[]} texts
 * @param {string | undefined} apiKey
 * @param {{signal?: AbortSignal}} [options]
 */
export async function embedBatch(texts, apiKey, { signal } = {}) {
  if (!apiKey) {
    throw new Error('OpenAI API key is not configured');
  }
  // OpenAI rejects empty inputs, so blank/whitespace-only inputs become "(empty)".
  const input = texts.map((text) => {
    const capped = String(text ?? '').slice(0, MAX_INPUT_CHARS);
    return capped.trim() ? capped : '(empty)';
  });
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      input,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`OpenAI embeddings API responded ${response.status}`);
  }
  const { data } = /** @type {{data: {index: number, embedding: number[]}[]}} */ (await response.json());
  const vectors = data.sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
  if (vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)) {
    throw new Error('OpenAI embeddings API returned an unexpected vector length');
  }
  return vectors;
}
