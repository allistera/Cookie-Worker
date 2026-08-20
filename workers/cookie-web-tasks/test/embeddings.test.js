import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embedBatch, embedText, embedTextCached } from '../src/embeddings.js';

/** @param {number[][]} vectors */
function fetchOk(vectors) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: vectors.map((embedding, index) => ({ index, embedding })) }),
  }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchOk([[0.1, 0.2]]));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('embedBatch', () => {
  it('sends every input in one call and returns vectors in input order', async () => {
    vi.stubGlobal('fetch', fetchOk([[0.3], [0.1], [0.2]]));
    const vectors = await embedBatch(['a', 'b', 'c'], 'sk-test');
    expect(vectors).toHaveLength(3);

    const [url, init] = /** @type {any} */ (fetch).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe(EMBEDDING_MODEL);
    expect(body.dimensions).toBe(EMBEDDING_DIMENSIONS);
    expect(body.input).toEqual(['a', 'b', 'c']);
  });

  it('re-sorts a response that arrives out of order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            { index: 1, embedding: [1] },
            { index: 0, embedding: [0] },
          ],
        }),
      })),
    );
    expect(await embedBatch(['first', 'second'], 'sk-test')).toEqual([[0], [1]]);
  });

  it('substitutes a placeholder for blank input, since OpenAI rejects empty strings', async () => {
    await embedBatch(['   '], 'sk-test');
    const [, init] = /** @type {any} */ (fetch).mock.calls[0];
    expect(JSON.parse(init.body).input).toEqual(['(empty)']);
  });

  it('throws without an API key, before making a request', async () => {
    await expect(embedBatch(['a'], undefined)).rejects.toThrow(/API key/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws when OpenAI responds with a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })));
    await expect(embedBatch(['a'], 'sk-test')).rejects.toThrow('429');
  });
});

describe('embedText', () => {
  it('embeds one string and returns its vector', async () => {
    vi.stubGlobal('fetch', fetchOk([[0.5, 0.6]]));
    await expect(embedText('hello', 'sk-test')).resolves.toEqual([0.5, 0.6]);
  });
});

describe('embedTextCached', () => {
  it('returns a cached vector for a repeated query without calling fetch again', async () => {
    vi.stubGlobal('fetch', fetchOk([[0.1, 0.2]]));
    const first = await embedTextCached('roadmap', 'sk-test');
    expect(fetch).toHaveBeenCalledOnce();

    const second = await embedTextCached('roadmap', 'sk-test');
    expect(fetch).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it('embeds a new query normally', async () => {
    vi.stubGlobal('fetch', fetchOk([[0.9]]));
    await expect(embedTextCached('a brand new query', 'sk-test')).resolves.toEqual([0.9]);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
