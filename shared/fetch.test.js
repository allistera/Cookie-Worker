import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchWithTimeout } from './fetch.js';

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
