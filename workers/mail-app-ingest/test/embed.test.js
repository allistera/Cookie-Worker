import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildEmbeddingInput,
  createEmbedding,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_INPUT_CAP,
  EMBEDDING_MODEL,
} from '../src/embed.js';

function vectorOf(length, value = 0.1) {
  return Array(length).fill(value);
}

/**
 * @returns {any}
 */
function mockedFetch() {
  return fetch;
}

describe('createEmbedding', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ embedding: vectorOf(EMBEDDING_DIMENSIONS) }] }),
      })),
    );
  });

  test('posts subject and body to OpenAI with the shared model contract', async () => {
    const vector = await createEmbedding({ subject: 'S', bodyText: 'B' }, 'key');
    const request = mockedFetch().mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      input: 'S\n\nB',
    });
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  test('caps input and turns blank content into one space', () => {
    expect(buildEmbeddingInput('', '')).toBe(' ');
    expect(buildEmbeddingInput('a'.repeat(30_000), '')).toHaveLength(EMBEDDING_INPUT_CAP);
  });

  test('throws status-only errors for non-2xx responses', async () => {
    mockedFetch().mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'secret body',
    });
    await expect(createEmbedding({ subject: 'S', bodyText: 'B' }, 'api-key')).rejects.toThrow(
      'OpenAI embeddings API responded 429',
    );
  });

  test('rejects vectors with the wrong dimension', async () => {
    mockedFetch().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    });
    await expect(createEmbedding({ subject: 'S', bodyText: 'B' }, 'key')).rejects.toThrow(
      `expected ${EMBEDDING_DIMENSIONS} dimensions`,
    );
  });
});
