import { afterEach, describe, expect, test, vi } from 'vitest';
import { flushScheduledSends } from '../src/worker.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const env = /** @type {any} */ ({
  COOKIE_WEB_FLUSH_URL: 'https://cookie-web.example/api/send?resource=flush',
  COOKIE_WEB_FLUSH_TOKEN: 'flush-secret',
});

describe('flushScheduledSends', () => {
  test('POSTs a bearer-authenticated request to the configured URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ claimed: 2, sent: 2, retried: 0, failed: 0 }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await flushScheduledSends(env);

    expect(result).toEqual({ claimed: 2, sent: 2, retried: 0, failed: 0 });
    const [url, init] = /** @type {[string, {method: string, headers: Record<string, string>}]} */ (
      /** @type {unknown} */ (fetchMock.mock.calls[0])
    );
    expect(url).toBe(env.COOKIE_WEB_FLUSH_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer flush-secret');
  });

  test('throws on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401 })),
    );
    await expect(flushScheduledSends(env)).rejects.toThrow('Cookie-Web flush responded 401');
  });

  test('retries a server error and succeeds', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ claimed: 1, sent: 1 }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const request = flushScheduledSends(env);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(request).resolves.toEqual({ claimed: 1, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('throws after persistent server errors', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    const request = flushScheduledSends(env);
    await vi.advanceTimersByTimeAsync(3000);

    await expect(request).rejects.toThrow('Cookie-Web flush responded 502');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('retries an aborted fetch and succeeds', async () => {
    vi.useFakeTimers();
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ claimed: 1, sent: 1 }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const request = flushScheduledSends(env);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(request).resolves.toEqual({ claimed: 1, sent: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('keeps the timeout active while parsing the response body', async () => {
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

    const request = flushScheduledSends(env);
    const rejection = expect(request).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
  });

  test('throws if COOKIE_WEB_FLUSH_URL is not configured', async () => {
    await expect(
      flushScheduledSends(/** @type {any} */ ({ COOKIE_WEB_FLUSH_TOKEN: 'x' })),
    ).rejects.toThrow('COOKIE_WEB_FLUSH_URL');
  });

  test('throws if COOKIE_WEB_FLUSH_TOKEN is not configured', async () => {
    await expect(
      flushScheduledSends(/** @type {any} */ ({ COOKIE_WEB_FLUSH_URL: 'https://x' })),
    ).rejects.toThrow('COOKIE_WEB_FLUSH_TOKEN');
  });
});
