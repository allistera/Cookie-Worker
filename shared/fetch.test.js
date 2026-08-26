import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchWithTimeout, readTextCapped } from './fetch.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchWithTimeout', () => {
  test('keeps the deadline active while the response body is read', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => ({
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      })),
    );

    const request = fetchWithTimeout('https://example.com', {}, (response) => response.json(), 50);
    const rejection = expect(request).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });
});

describe('readTextCapped', () => {
  test('reads a streamed body under the cap', async () => {
    await expect(readTextCapped(new Response('hello feed'), 1024)).resolves.toBe('hello feed');
  });

  test('aborts a streamed body that exceeds the cap', async () => {
    await expect(readTextCapped(new Response('x'.repeat(2048)), 1024)).rejects.toThrow(
      'exceeded 1024 bytes',
    );
  });

  test('enforces the cap on non-streaming stand-ins too', async () => {
    const stub = /** @type {any} */ ({ body: null, text: async () => 'y'.repeat(2048) });
    await expect(readTextCapped(stub, 1024)).rejects.toThrow('exceeded 1024 bytes');
  });
});
