import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushScheduledSends } from '../src/worker.js';

// The flush call goes over the SEND service binding to cookie-web-send;
// sendFetch stands in for the bound Worker's fetch.
const sendFetch = vi.fn();
const env = /** @type {any} */ ({
  SEND: { fetch: (/** @type {any[]} */ ...args) => sendFetch(...args) },
  COOKIE_WEB_FLUSH_TOKEN: 'flush-secret',
});

beforeEach(() => {
  sendFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('flushScheduledSends', () => {
  test('POSTs a bearer-authenticated request over the SEND binding', async () => {
    sendFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ claimed: 2, sent: 2, retried: 0, failed: 0 }),
    });

    const result = await flushScheduledSends(env);

    expect(result).toEqual({ claimed: 2, sent: 2, retried: 0, failed: 0 });
    const [url, init] = /** @type {[string, {method: string, headers: Record<string, string>}]} */ (
      /** @type {unknown} */ (sendFetch.mock.calls[0])
    );
    expect(url).toBe('https://cookie-web-send/send/flush');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer flush-secret');
  });

  test('throws on a non-OK response', async () => {
    sendFetch.mockResolvedValue({ ok: false, status: 401 });
    await expect(flushScheduledSends(env)).rejects.toThrow('Cookie-Web flush responded 401');
  });

  test('includes the upstream error body', async () => {
    sendFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"Email sending is not configured"}',
    });

    await expect(flushScheduledSends(env)).rejects.toThrow(
      'Cookie-Web flush responded 401: {"error":"Email sending is not configured"}',
    );
  });

  test('redacts the flush token from the upstream error body', async () => {
    sendFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => `{"error":"Bearer ${env.COOKIE_WEB_FLUSH_TOKEN}"}`,
    });

    const error = await flushScheduledSends(env).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Cookie-Web flush responded 401');
    expect(error.message).not.toContain(env.COOKIE_WEB_FLUSH_TOKEN);
  });

  test('keeps the bare status when the upstream error body cannot be read', async () => {
    sendFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => {
        throw new Error('body stream already read');
      },
    });

    await expect(flushScheduledSends(env)).rejects.toThrow('Cookie-Web flush responded 401');
  });

  test('retries a server error and succeeds', async () => {
    vi.useFakeTimers();
    sendFetch.mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ claimed: 1, sent: 1 }),
    });

    const request = flushScheduledSends(env);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(request).resolves.toEqual({ claimed: 1, sent: 1 });
    expect(sendFetch).toHaveBeenCalledTimes(2);
  });

  test('throws after persistent server errors', async () => {
    vi.useFakeTimers();
    sendFetch.mockResolvedValue({ ok: false, status: 502 });

    const request = flushScheduledSends(env);
    const rejection = expect(request).rejects.toThrow('Cookie-Web flush responded 502');
    await vi.advanceTimersByTimeAsync(3000);

    await rejection;
    expect(sendFetch).toHaveBeenCalledTimes(3);
  });

  test('retries an aborted fetch and succeeds', async () => {
    vi.useFakeTimers();
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    sendFetch.mockRejectedValueOnce(abortError).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ claimed: 1, sent: 1 }),
    });

    const request = flushScheduledSends(env);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(request).resolves.toEqual({ claimed: 1, sent: 1 });
    expect(sendFetch).toHaveBeenCalledTimes(2);
  });

  test('keeps the timeout active while parsing the response body', async () => {
    vi.useFakeTimers();
    sendFetch.mockImplementation(async (/** @type {any} */ _url, /** @type {any} */ init) => ({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    }));

    const request = flushScheduledSends(env);
    const rejection = expect(request).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
  });

  test('throws if the SEND binding is not configured', async () => {
    await expect(
      flushScheduledSends(/** @type {any} */ ({ COOKIE_WEB_FLUSH_TOKEN: 'x' })),
    ).rejects.toThrow('SEND service binding');
  });

  test('throws if COOKIE_WEB_FLUSH_TOKEN is not configured', async () => {
    await expect(
      flushScheduledSends(/** @type {any} */ ({ SEND: { fetch: vi.fn() } })),
    ).rejects.toThrow('COOKIE_WEB_FLUSH_TOKEN');
  });
});
