// Ported from Cookie-Web's api/_lib/embeddings.js (which Cookie-Web keeps —
// api/send.js and the backfill scripts still embed there). The query cache
// is per-isolate here, as it was per-instance on Vercel.
// OpenAI embeddings client. Used by /api/search for query vectors and by
// scripts/backfill-embeddings.js for message vectors.

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

// ~6k tokens, comfortably under the model's 8191-token input limit.
const MAX_INPUT_CHARS = 24000;

// Embeds one string; returns a 1536-number array. options.signal aborts the
// request (e.g. AbortSignal.timeout(ms)) — used by document autosave so a
// hung OpenAI call can't stall the serialized save queue indefinitely.
export async function embedText(text, apiKey, options) {
  const [vector] = await embedBatch([text], apiKey, options);
  return vector;
}

// LRU-cached variant for user queries: repeat searches (retries, re-submits,
// back-navigation) skip the OpenAI round-trip and its cost. Per-instance
// cache, like everything in-memory on Fluid Compute.
const queryCache = new Map();
const QUERY_CACHE_MAX = 200;

export async function embedTextCached(text, apiKey) {
  if (queryCache.has(text)) {
    const vector = queryCache.get(text);
    queryCache.delete(text);
    queryCache.set(text, vector); // refresh recency
    return vector;
  }
  const vector = await embedText(text, apiKey, { signal: AbortSignal.timeout(8_000) });
  queryCache.set(text, vector);
  if (queryCache.size > QUERY_CACHE_MAX) {
    queryCache.delete(queryCache.keys().next().value);
  }
  return vector;
}

// Embeds several strings in one API call; returns arrays in input order.
/**
 * @param {unknown[]} texts
 * @param {string} apiKey
 * @param {{signal?: AbortSignal}} [options]
 */
export async function embedBatch(texts, apiKey, { signal } = {}) {
  if (!apiKey) {
    throw new Error('OpenAI API key is not configured');
  }
  // OpenAI rejects empty inputs, so blank/whitespace-only inputs (e.g. a
  // message with neither subject nor body -> "\n\n") become "(empty)".
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
  const { data } = await response.json();
  return data.sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
}
