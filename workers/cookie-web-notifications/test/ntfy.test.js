import { describe, expect, test, vi } from 'vitest';
import {
  createNtfySubscription,
  deliverPendingNtfy,
  NtfyPublishError,
  publishNtfy,
  sendNtfyTest,
} from '../src/ntfy.js';

describe('ntfy delivery', () => {
  test('publishes the subject as the title and plain-text email as the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await publishNtfy(
      {
        topic: 'cookie-random-topic',
        messageId: '11111111-1111-1111-1111-111111111111',
        subject: 'Your winter vaccine appointment reminder',
        bodyText: 'Please book your appointment before Friday.',
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
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Title': 'Your winter vaccine appointment reminder',
        'X-Click':
          'https://mail.infinitywave.online/inbox?open=11111111-1111-1111-1111-111111111111',
        // A button that opens the email in the iOS app; the tap itself keeps
        // opening the web inbox so desktop ntfy clients still land somewhere.
        'X-Actions':
          'view, Open in Cookie app, com.cookie.ios://inbox?open=11111111-1111-1111-1111-111111111111, clear=true',
      }),
    );
    expect(request.body).toBe('Please book your appointment before Friday.');
  });

  test('uses readable fallbacks when the subject and plain-text body are empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await publishNtfy(
      { topic: 'cookie-topic', messageId: 'message-1', subject: '  ', bodyText: '  ' },
      { fetchImpl },
    );

    const [, request] = fetchImpl.mock.calls[0];
    expect(request.headers['X-Title']).toBe('(No subject)');
    expect(request.body).toBe('No plain-text content available.');
  });

  test('truncates long plain-text bodies to fit within the ntfy message limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    await publishNtfy(
      {
        topic: 'cookie-topic',
        messageId: 'message-1',
        subject: 'Subject',
        bodyText: 'a'.repeat(4000),
      },
      { fetchImpl },
    );

    const [, request] = fetchImpl.mock.calls[0];
    expect(new TextEncoder().encode(request.body)).toHaveLength(3500);
    expect(request.body.endsWith('…')).toBe(true);
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
            subject: 'Appointment reminder',
            body_text: 'Please confirm by Friday.',
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
    const [, request] = fetchImpl.mock.calls[0];
    expect(request.headers['X-Title']).toBe('Appointment reminder');
    expect(request.body).toBe('Please confirm by Friday.');
  });

  test('updates queued events only from the rows selected by the pending CTE', async () => {
    const sql = /** @type {any} */ (vi.fn().mockResolvedValueOnce([]));

    await deliverPendingNtfy(sql, { fetchImpl: vi.fn() });

    const query = sql.mock.calls[0][0].join(' ').replace(/\s+/g, ' ');
    expect(query).toContain('FROM pending');
    expect(query).not.toContain('FROM pending JOIN');
    expect(query).toContain('RETURNING pending.event_id, pending.message_id, pending.topic');
    expect(query).toContain('pending.body_text');
    expect(query).toContain("ai.status IS DISTINCT FROM 'pending'");
    expect(query).toContain("ai.updated_at <= now() - interval '5 minutes'");
    expect(query).toContain('LEFT JOIN email_categories category');
    expect(query).toContain('message.id = event.message_id AND message.user_id = event.user_id');
    expect(query).toContain('(message.category_id IS NULL OR category.notifications_enabled)');
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
    expect(request.headers['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(request.body).toBe('Your ntfy notifications are working.');
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
