import { afterEach, describe, expect, test, vi } from 'vitest';
import { flushScheduledSends } from '../src/worker.js';

afterEach(() => {
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
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));
    await expect(flushScheduledSends(env)).rejects.toThrow('Cookie-Web flush responded 401');
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
