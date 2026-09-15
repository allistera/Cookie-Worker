import { describe, expect, test, vi } from 'vitest';
import {
  createNtfySubscription,
  deliverPendingNtfy,
  NtfyPublishError,
  publishNtfy,
  sendNtfyTest,
} from '../src/ntfy.js';

describe('ntfy delivery', () => {
  test('publishes a privacy-safe notification with a Cookie deep link', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await publishNtfy(
      {
        topic: 'cookie-random-topic',
        messageId: '11111111-1111-1111-1111-111111111111',
        sender: 'NHS',
        subject: 'Your winter vaccine appointment reminder',
      },
      { baseUrl: 'https://ntfy.sh', fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ntfy.sh/cookie-random-topic',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, request] = fetchImpl.mock.calls[0];
    expect(request.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Title': 'New email from NHS',
        'X-Click':
          'https://mail.infinitywave.online/inbox?open=11111111-1111-1111-1111-111111111111',
      }),
    );
    expect(JSON.parse(request.body)).toEqual({
      topic: 'cookie-random-topic',
      message: 'Your winter vaccine appointment reminder',
    });
  });

  test('honours Retry-After and retries a rate-limited publish', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '2' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await publishNtfy(
      { topic: 'cookie-topic', messageId: 'message-1', subject: 'Subject' },
      { baseUrl: 'https://ntfy.sh', fetchImpl, sleepImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(2000);
  });

  test('retries a transient server failure before succeeding', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await publishNtfy(
      { topic: 'cookie-topic', messageId: 'message-1', subject: 'Subject' },
      { baseUrl: 'https://ntfy.sh', fetchImpl, sleepImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledOnce();
  });

  test('uses three attempts by default for a transient provider failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await expect(
      publishNtfy(
        { topic: 'cookie-topic', messageId: 'message-1', subject: 'Subject' },
        { fetchImpl, sleepImpl },
      ),
    ).rejects.toMatchObject({ status: 503 });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 250);
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 500);
  });

  test('caps an excessive Retry-After delay', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '999' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    await publishNtfy(
      { topic: 'cookie-topic', messageId: 'message-1', subject: 'Subject' },
      { fetchImpl, sleepImpl },
    );

    expect(sleepImpl).toHaveBeenCalledWith(5000);
  });

  test('throws a structured error when rate-limit retries are exhausted', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '3' } }),
      );

    const failure = expect(
      publishNtfy(
        { topic: 'cookie-topic', messageId: 'message-1', subject: 'Subject' },
        {
          baseUrl: 'https://ntfy.sh',
          fetchImpl,
          maxAttempts: 2,
          sleepImpl: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).rejects;

    await failure.toBeInstanceOf(NtfyPublishError);
    await failure.toMatchObject({ status: 429, retryAfterSeconds: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('delivers eligible queued events and records success', async () => {
    const sql = /** @type {any} */ (
      vi
        .fn()
        .mockResolvedValueOnce([
          {
            event_id: 'event-1',
            message_id: 'message-1',
            topic: 'cookie-topic',
            from_name: 'NHS',
            subject: 'Appointment reminder',
          },
        ])
        .mockResolvedValueOnce([])
    );
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(
      deliverPendingNtfy(sql, { baseUrl: 'https://ntfy.sh', fetchImpl }),
    ).resolves.toEqual({ attempted: 1, delivered: 1, failed: 0 });
    expect(sql).toHaveBeenCalledTimes(2);
    expect(sql.mock.calls[1][0].join(' ')).toContain('published_at = now()');
  });

  test('updates queued events only from the rows selected by the pending CTE', async () => {
    const sql = /** @type {any} */ (vi.fn().mockResolvedValueOnce([]));

    await deliverPendingNtfy(sql, { fetchImpl: vi.fn() });

    const query = sql.mock.calls[0][0].join(' ').replace(/\s+/g, ' ');
    expect(query).toContain('FROM pending');
    expect(query).not.toContain('FROM pending JOIN');
    expect(query).toContain('RETURNING pending.event_id, pending.message_id, pending.topic');
  });
});

describe('ntfy subscription', () => {
  test('creates a random topic and returns its subscription URL', async () => {
    const sql = /** @type {any} */ (
      vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ topic: 'cookie-generated-topic', enabled: true }])
    );
    const result = await createNtfySubscription(sql, 'user-1', {
      makeTopic: () => 'generated-topic',
    });

    expect(sql).toHaveBeenCalled();
    expect(result).toEqual({
      topic: 'cookie-generated-topic',
      subscribeUrl: 'https://ntfy.allisterantosik.com/cookie-generated-topic',
      enabled: true,
    });
  });

  test('returns the configured self-hosted subscription URL', async () => {
    const sql = /** @type {any} */ (
      vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ topic: 'cookie-generated-topic', enabled: true }])
    );

    const result = await createNtfySubscription(sql, 'user-1', {
      baseUrl: 'https://ntfy.allisterantosik.com',
      makeTopic: () => 'generated-topic',
    });

    expect(result.subscribeUrl).toBe('https://ntfy.allisterantosik.com/cookie-generated-topic');
  });

  test('sends a clearly labelled test notification to the enabled user topic', async () => {
    const sql = /** @type {any} */ (
      vi.fn().mockResolvedValueOnce([{ topic: 'cookie-user-topic' }])
    );
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(
      sendNtfyTest(sql, 'user-1', { baseUrl: 'https://ntfy.sh', fetchImpl }),
    ).resolves.toEqual({ sent: true });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ntfy.sh/cookie-user-topic');
    expect(request.headers['X-Title']).toBe('Cookie notification test');
    expect(JSON.parse(request.body)).toEqual({
      topic: 'cookie-user-topic',
      message: 'Your ntfy notifications are working.',
    });
  });

  test('does not publish a test when the user has no enabled subscription', async () => {
    const sql = /** @type {any} */ (vi.fn().mockResolvedValueOnce([]));
    const fetchImpl = vi.fn();

    await expect(sendNtfyTest(sql, 'user-1', { fetchImpl })).rejects.toThrow(
      'ntfy subscription is not enabled',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
