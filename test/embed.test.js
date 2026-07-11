import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildEmbeddingInput,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embedMessage,
} from '../src/embed.js';
import { createMockSql } from './helpers.js';

function vectorOf(length, value = 0.1) {
  return Array(length).fill(value);
}

describe('embedMessage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: vectorOf(EMBEDDING_DIMENSIONS) }] }),
    })));
  });

  test('posts subject and body to OpenAI with the shared model contract', async () => {
    const sql = createMockSql();
    await embedMessage(sql, { messageId: '<id>', subject: 'S', bodyText: 'B' }, 'message-1', 'key');
    const request = fetch.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      input: 'S\n\nB',
    });
    expect(sql.queries.at(-1).text).toContain('AND embedding IS NULL');
  });

  test('caps input and turns blank content into one space', () => {
    expect(buildEmbeddingInput('', '')).toBe(' ');
    expect(buildEmbeddingInput('a'.repeat(30000), '')).toHaveLength(24000);
  });

  test('throws status-only errors for non-2xx responses', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'secret body' });
    await expect(embedMessage(createMockSql(), { messageId: '<id>', subject: 'S', bodyText: 'B' }, 'message-1', 'api-key'))
      .rejects.toThrow('OpenAI embeddings API responded 429');
  });

  test('rejects vectors with the wrong dimension', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    });
    await expect(embedMessage(createMockSql(), { messageId: '<id>', subject: 'S', bodyText: 'B' }, 'message-1', 'key'))
      .rejects.toThrow(`expected ${EMBEDDING_DIMENSIONS} dimensions`);
  });
});
