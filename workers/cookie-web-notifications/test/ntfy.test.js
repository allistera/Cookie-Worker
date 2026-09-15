import { describe, expect, test, vi } from 'vitest';
import { createNtfySubscription, deliverPendingNtfy, publishNtfy } from '../src/ntfy.js';

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

  test('rejects a failed ntfy response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));

    await expect(
      publishNtfy(
        { topic: 'cookie-topic', messageId: 'message-1', subject: 'Subject' },
        { baseUrl: 'https://ntfy.sh', fetchImpl },
      ),
    ).rejects.toThrow('ntfy responded 429');
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
});

describe('ntfy subscription', () => {
  test('creates a random topic and returns its subscription URL', async () => {
    const sql = /** @type {any} */ (
      vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ topic: 'cookie-generated-topic', enabled: true }])
    );
    const result = await createNtfySubscription(sql, 'user-1', () => 'generated-topic');

    expect(sql).toHaveBeenCalled();
    expect(result).toEqual({
      topic: 'cookie-generated-topic',
      subscribeUrl: 'https://ntfy.sh/cookie-generated-topic',
      enabled: true,
    });
  });
});
