import { Meilisearch } from 'meilisearch';
import { describe, expect, it, vi } from 'vitest';
import { isTransientMeiliError } from './meiliErrors.js';

// Use the installed SDK's actual response handling: a gateway's plain-text
// body must still reach our code as an API error carrying the HTTP status.
describe('Meilisearch gateway failures', () => {
  it.each([502, 503, 504, 520, 530])('recognizes a plain-text %s from the SDK', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(`error code: ${status}\n`, { status })),
    );
    try {
      const client = new Meilisearch({ host: 'https://meili.test' });
      const error = await client.tasks.getTask(7).catch((error) => error);
      expect(error.response.status).toBe(status);
      expect(isTransientMeiliError(error)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    new SyntaxError('Unexpected end of JSON input'),
    new SyntaxError('Unexpected token \'e\', "error code: 502\n" is not valid JSON'),
    new Error('error code: 502'),
    Object.assign(new Error('invalid key'), { response: { status: 401 } }),
  ])('does not retry an unrelated failure: %s', (error) => {
    expect(isTransientMeiliError(error)).toBe(false);
  });
});
