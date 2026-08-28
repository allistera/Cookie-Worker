import { fetchWithTimeout } from '../../../shared/fetch.js';

export const AI_FETCH_TIMEOUT_MS = 60_000;
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
// Character cap, not tokens. text-embedding-3-small allows ~8192 tokens; dense
// scripts approach ~1 char/token, so stay well under that without a tokenizer.
export const EMBEDDING_INPUT_CAP = 8000;
export const EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

export class EmbeddingApiError extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`OpenAI embeddings API responded ${status}`);
    this.name = 'EmbeddingApiError';
    this.status = status;
  }
}

/**
 * Fetches a vector without holding a database concern, so AI enrichment can
 * run classification and embedding requests concurrently.
 * @param {{subject?: string | null, bodyText?: string | null}} record
 * @param {string} apiKey
 */
export async function createEmbedding(record, apiKey) {
  const input = buildEmbeddingInput(record.subject, record.bodyText);
  return fetchWithTimeout(
    EMBEDDINGS_URL,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        input,
      }),
    },
    async (response) => {
      if (!response.ok) throw new EmbeddingApiError(response.status);
      const body = await response.json();
      const vector = body?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `OpenAI embeddings API returned invalid vector (expected ${EMBEDDING_DIMENSIONS} dimensions)`,
        );
      }
      return vector;
    },
    AI_FETCH_TIMEOUT_MS,
  );
}

/**
 * @param {string | null | undefined} subject
 * @param {string | null | undefined} bodyText
 */
export function buildEmbeddingInput(subject, bodyText) {
  const input = `${subject ?? ''}\n\n${bodyText ?? ''}`.slice(0, EMBEDDING_INPUT_CAP);
  return input.trim() ? input : ' ';
}
