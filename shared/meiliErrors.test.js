import { Meilisearch } from 'meilisearch';
import { describe, expect, it, vi } from 'vitest';
import { isTransientMeiliError } from './meiliErrors.js';

// Use the installed SDK's actual JSON parser: the gateway response loses its
// HTTP status before our code sees it, rather than becoming an API error.
describe('Meilisearch gateway failures', () => {
  it.each([502, 503, 504, 520, 530])('recognizes a plain-text %s from the SDK', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(`error code: ${status}\n`, { status })),
    );
    try {
      const client = new Meilisearch({ host: 'https://meili.test' });
      const error = await client.tasks.getTask(7).catch((error) => error);
      expect(error).toBeInstanceOf(SyntaxError);
      expect(isTransientMeiliError(error)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    new SyntaxError('Unexpected end of JSON input'),
    new SyntaxError('Unexpected token \'e\', "error code: 401\n" is not valid JSON'),
    new Error('error code: 502'),
    Object.assign(new Error('invalid key'), { response: { status: 401 } }),
  ])('does not retry an unrelated failure: %s', (error) => {
    expect(isTransientMeiliError(error)).toBe(false);
  });
});
