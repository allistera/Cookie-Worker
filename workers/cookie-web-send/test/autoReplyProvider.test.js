import { describe, expect, test, vi } from 'vitest';
import {
  autoReplyPayload,
  flushWithOutOfOffice,
  runOutOfOfficeInBackground,
} from '../src/outOfOffice.js';
import { sendAutoReply } from '../src/autoReplyProvider.js';

describe('automatic provider payload and failure contract', () => {
  test('sends exactly the reviewed text, configured identity, loop headers and stable key', async () => {
    const payload = autoReplyPayload(
      { subject: 'Away', text: '<b>Literal text</b>' },
      {
        envelope_from: 'Sender@example.com',
        message_id: '<source@example.com>',
        headers: [{ key: 'reply-to', value: 'attacker@example.com' }],
      },
      'Cookie <mail@example.com>',
    );
    const fetcher = vi.fn(async () => Response.json({ id: 'provider-1' }));
    expect(await sendAutoReply(payload, 'out-of-office/id', 'test', fetcher)).toEqual({
      status: 'sent',
      providerId: 'provider-1',
    });
    const [url, request] = /** @type {any} */ (fetcher.mock.calls[0]);
    expect(url).toBe('https://api.resend.com/emails');
    expect(request.headers['Idempotency-Key']).toBe('out-of-office/id');
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(request.body)).toEqual({
      from: 'Cookie <mail@example.com>',
      to: ['sender@example.com'],
      subject: 'Away',
      text: '<b>Literal text</b>',
      headers: {
        'Auto-Submitted': 'auto-replied',
        'X-Auto-Response-Suppress': 'All',
        Precedence: 'bulk',
        'In-Reply-To': '<source@example.com>',
        References: '<source@example.com>',
      },
    });
  });
  test('excludes untrusted header injection', () => {
    const payload = autoReplyPayload(
      { subject: 'Away', text: 'Bye' },
      { envelope_from: 'sender@example.com', message_id: '<source>\r\nBcc: hidden@example.com' },
      'mail@example.com',
    );
    expect(payload.headers).not.toHaveProperty('In-Reply-To');
  });
  test.each([
    [400, 'rejected'],
    [403, 'rejected'],
    [408, 'retry'],
    [409, 'retry'],
    [429, 'retry'],
    [500, 'retry'],
  ])('maps provider HTTP %i without leaking error content', async (status, expected) => {
    const fetcher = /** @type {typeof fetch} */ (
      async () => Response.json({ message: 'private provider details' }, { status: Number(status) })
    );
    expect(await sendAutoReply({}, 'key', 'test', fetcher)).toEqual({
      status: expected,
      providerId: null,
    });
  });
  test('treats transport abort and malformed success as ambiguous', async () => {
    expect(
      (
        await sendAutoReply({}, 'key', 'test', async () => {
          throw new DOMException('timeout', 'AbortError');
        })
      ).status,
    ).toBe('retry');
    expect((await sendAutoReply({}, 'key', 'test', async () => Response.json({}))).status).toBe(
      'retry',
    );
  });
  test('stops payload-conflict retries for manual review', async () => {
    expect(
      (
        await sendAutoReply({}, 'key', 'test', async () =>
          Response.json({ name: 'invalid_idempotent_request' }, { status: 409 }),
        )
      ).status,
    ).toBe('uncertain');
  });
  test('aborts a stalled provider within the remaining background budget', async () => {
    const fetcher = /** @type {typeof fetch} */ (
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    expect(await sendAutoReply({}, 'key', 'test', fetcher, 5)).toEqual({
      status: 'retry',
      providerId: null,
    });
  });
});

describe('flush legs stay independent', () => {
  const sql = /** @type {any} */ ({});
  const services = /** @type {any} */ ({});
  test('closes a stalled dedicated client before the platform background limit', async () => {
    vi.useFakeTimers();
    let rejectQuery;
    const stalled = new Promise((_resolve, reject) => {
      rejectQuery = reject;
    });
    const dedicated = /** @type {any} */ (() => stalled);
    dedicated.end = vi.fn(async () => {
      rejectQuery(new Error('connection closed'));
    });
    const background = runOutOfOfficeInBackground(
      dedicated,
      /** @type {any} */ ({ env: { EMAIL_FROM: 'mail@example.com' } }),
    );
    const result = expect(background).rejects.toThrow('connection closed');
    try {
      await vi.advanceTimersByTimeAsync(22_000);
      await result;
      expect(dedicated.end).toHaveBeenNthCalledWith(1, { timeout: 0 });
      expect(dedicated.end).toHaveBeenNthCalledWith(2, { timeout: 2 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  test('preserves the scheduled response when automatic enqueue/delivery fails', async () => {
    const response = Response.json({ sent: 2 });
    const waited = [];
    const automatic = vi.fn(async () => {
      throw new Error('missing migration');
    });
    expect(
      await flushWithOutOfOffice(
        sql,
        services,
        async () => response,
        (promise) => waited.push(promise),
        automatic,
      ),
    ).toBe(response);
    await Promise.all(waited);
    expect(await response.json()).toEqual({ sent: 2 });
  });
  test('returns the scheduled response without waiting for an automatic provider', async () => {
    const response = Response.json({ sent: 2 });
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const waited = [];
    expect(
      await flushWithOutOfOffice(
        sql,
        services,
        async () => response,
        (promise) => waited.push(promise),
        () => pending,
      ),
    ).toBe(response);
    expect(waited).toHaveLength(1);
    release();
    await Promise.all(waited);
  });
  test('still runs automatic replies after a scheduled exception or failure response', async () => {
    const automatic = vi.fn(async () => undefined);
    const waited = [];
    const waitUntil = (promise) => waited.push(promise);
    const response = await flushWithOutOfOffice(
      sql,
      services,
      async () => {
        throw new Error('scheduled failure');
      },
      waitUntil,
      automatic,
    );
    expect(response.status).toBe(500);
    expect(automatic).toHaveBeenCalledOnce();
    const failure = Response.json({ error: 'Flush failed' }, { status: 500 });
    expect(
      await flushWithOutOfOffice(sql, services, async () => failure, waitUntil, automatic),
    ).toBe(failure);
    expect(automatic).toHaveBeenCalledTimes(2);
    await Promise.all(waited);
  });
});
