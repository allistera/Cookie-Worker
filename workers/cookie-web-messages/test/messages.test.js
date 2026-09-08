import { describe, expect, test, vi } from 'vitest';
import {
  fetchMessageAttachments,
  fetchOwnedMessageBody,
  fetchThreadMessages,
  getAttachment,
  getMessage,
  patchMessage,
  postMessage,
  recipientAddress,
} from '../src/messages.js';
import { createMockSql } from './helpers.js';

vi.mock('../../../shared/rate-limit.js', () => ({
  allowRequest: vi.fn().mockResolvedValue(true),
}));

const USER_ID = '99999999-9999-4999-8999-999999999999';
const MESSAGE_ID = '11111111-1111-1111-1111-111111111111';
const LABEL_ID = '22222222-2222-2222-2222-222222222222';
const ATTACHMENT_ID = '33333333-3333-3333-3333-333333333333';
const CATEGORY_ID = '44444444-4444-4444-8444-444444444444';

/**
 * @param {Partial<import('../src/messages.js').UnsubscribeDeps &
 *   import('../src/messages.js').ReindexDeps>} [overrides]
 */
function unsubscribeDeps(overrides = {}) {
  return {
    requestPublicHttps: vi.fn(),
    resendApiKey: undefined,
    emailFrom: undefined,
    sendEmail: vi.fn(),
    ...overrides,
  };
}

describe('postMessage — thread muting', () => {
  test.each([true, false])('persists muted=%s on the owned conversation', async (muted) => {
    const thread = { id: LABEL_ID, is_muted: muted };
    const sql = createMockSql([[thread], []]);
    const response = await postMessage(
      sql,
      USER_ID,
      {
        id: MESSAGE_ID,
        action: muted ? 'mute_thread' : 'unmute_thread',
      },
      unsubscribeDeps(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thread });
    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(sql.calls[0].text).toContain('UPDATE threads t');
    expect(sql.calls[0].text).toContain('NOT m.is_deleted');
    expect(sql.calls[0].text).toContain('t.user_id = ?');
    expect(sql.calls[0].values).toEqual([muted, MESSAGE_ID, USER_ID, USER_ID]);
    expect(sql.calls).toHaveLength(muted ? 2 : 1);
    if (muted) {
      expect(sql.calls[1].text).toContain('DELETE FROM browser_notification_events');
      expect(sql.calls[1].values).toEqual([LABEL_ID, USER_ID, USER_ID]);
    }
  });

  test('does not change or purge another user’s thread', async () => {
    const sql = createMockSql([[]]);
    const response = await postMessage(
      sql,
      USER_ID,
      {
        id: MESSAGE_ID,
        action: 'mute_thread',
      },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(404);
    expect(sql.calls).toHaveLength(1);
  });

  test('rejects an invalid message id before touching the database', async () => {
    const sql = createMockSql();
    const response = await postMessage(
      sql,
      USER_ID,
      {
        id: 'invalid',
        action: 'mute_thread',
      },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('postMessage — label actions', () => {
  test('applies a label and returns the message label set', async () => {
    const sql = createMockSql([
      [{ label_id: LABEL_ID }], // INSERT ... RETURNING
      [], // search_indexed_at drift mark
      [{ name: 'Work', color: '#3b82f6', kind: 'user' }], // labels read-back
    ]);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'add_label', label_id: LABEL_ID },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      labels: [{ name: 'Work', color: '#3b82f6', kind: 'user' }],
    });
  });

  test('removes a label and returns the remaining set', async () => {
    const sql = createMockSql([
      [{ label_id: LABEL_ID }], // DELETE ... RETURNING
      [], // search_indexed_at drift mark
      [], // labels read-back
    ]);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'remove_label', label_id: LABEL_ID },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ labels: [] });
  });

  test('rejects a malformed label_id with 400', async () => {
    const sql = createMockSql();
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'add_label', label_id: 'not-a-uuid' },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/label_id/);
  });

  test('404s when the message is not the caller’s', async () => {
    const sql = createMockSql([
      [], // INSERT returned nothing
      [{ message: false, label: true }], // ownership check
    ]);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'add_label', label_id: LABEL_ID },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Message not found');
  });

  test('404s when the label is not the caller’s', async () => {
    const sql = createMockSql([
      [], // INSERT returned nothing
      [{ message: true, label: false }], // ownership check
    ]);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'add_label', label_id: LABEL_ID },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Label not found');
  });

  test('rejects an unknown action with 400', async () => {
    const sql = createMockSql();
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'frobnicate' },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(400);
  });

  test('rejects a missing id with 400 before touching the database', async () => {
    const sql = createMockSql();
    const response = await postMessage(sql, USER_ID, { action: 'unsubscribe' }, unsubscribeDeps());
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('postMessage — category action', () => {
  test('sets or replaces the single category and returns it', async () => {
    const category = { id: CATEGORY_ID, name: 'Projects', color: '#3b82f6' };
    const sql = createMockSql([[{ id: MESSAGE_ID }], [category]]);
    const onMessageChanged = vi.fn();
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'set_category', category_id: CATEGORY_ID },
      unsubscribeDeps({ onMessageChanged }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ category });
    expect(sql.calls[0].text).toContain('SET category_id =');
    expect(sql.calls[0].text).toContain('email_categories');
    expect(sql.calls[0].text).toContain('m.category_id IS DISTINCT FROM');
    expect(sql.calls.map((call) => call.text).join('\n')).not.toContain('search_indexed_at');
    expect(onMessageChanged).not.toHaveBeenCalled();
  });

  test('clears the current category', async () => {
    const sql = createMockSql([[{ id: MESSAGE_ID }], []]);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'set_category', category_id: null },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ category: null });
    expect(sql.calls[0].text).toContain('SET category_id = NULL');
  });

  test('treats assigning the existing category as an idempotent success', async () => {
    const category = { id: CATEGORY_ID, name: 'Projects', color: '#3b82f6' };
    const sql = createMockSql([[], [{ message: true, category: true }], [category]]);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'set_category', category_id: CATEGORY_ID },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ category });
  });

  test('rejects a malformed category id', async () => {
    const sql = createMockSql();
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'set_category', category_id: 'invalid' },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('does not attach another user’s category', async () => {
    const sql = createMockSql([[], [{ message: true, category: false }]]);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'set_category', category_id: CATEGORY_ID },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Category not found');
  });
});

describe('postMessage — unsubscribe action', () => {
  test('sends one-click unsubscribe through the SSRF-safe request boundary', async () => {
    const sql = createMockSql([
      [
        {
          headers: [
            { key: 'List-Unsubscribe', value: '<https://news.list-manage.com/unsubscribe?id=123>' },
            { key: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
          ],
        },
      ],
    ]);
    const requestPublicHttps = vi.fn().mockResolvedValue({ status: 204 });
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe' },
      unsubscribeDeps({ requestPublicHttps }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'unsubscribed', method: 'one-click' });
    expect(requestPublicHttps).toHaveBeenCalledWith(
      'https://news.list-manage.com/unsubscribe?id=123',
      expect.objectContaining({
        method: 'POST',
        body: 'List-Unsubscribe=One-Click',
        timeoutMs: 10_000,
      }),
    );
  });

  test('falls back to a manual link when the one-click POST fails', async () => {
    const sql = createMockSql([
      [
        {
          headers: [
            { key: 'List-Unsubscribe', value: '<https://news.list-manage.com/unsubscribe?id=123>' },
            { key: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
          ],
        },
      ],
    ]);
    const requestPublicHttps = vi.fn().mockRejectedValue(new Error('DNS failed'));
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe' },
      unsubscribeDeps({ requestPublicHttps }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'manual',
      method: 'link',
      url: 'https://news.list-manage.com/unsubscribe?id=123',
    });
  });

  test('sends a mailto unsubscribe via Resend when configured and there is no one-click link', async () => {
    const sql = createMockSql([
      [{ headers: [{ key: 'List-Unsubscribe', value: '<mailto:unsub@example.com>' }] }],
    ]);
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe' },
      unsubscribeDeps({ resendApiKey: 'key', emailFrom: 'Cookie <mail@example.com>', sendEmail }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'unsubscribed', method: 'mailto' });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'key', to: ['unsub@example.com'] }),
    );
  });

  test('sends one-click to any https host, not just known ESPs', async () => {
    const sql = createMockSql([
      [
        {
          headers: [
            { key: 'List-Unsubscribe', value: '<https://unsub.acme-esp.example/u?id=1>' },
            { key: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
          ],
        },
      ],
    ]);
    const requestPublicHttps = vi.fn().mockResolvedValue({ status: 204 });
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe' },
      unsubscribeDeps({ requestPublicHttps }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'unsubscribed', method: 'one-click' });
    expect(requestPublicHttps).toHaveBeenCalledWith(
      'https://unsub.acme-esp.example/u?id=1',
      expect.objectContaining({ method: 'POST', body: 'List-Unsubscribe=One-Click' }),
    );
  });

  test('never makes a server-side request for a non-https one-click URL', async () => {
    const sql = createMockSql([
      [
        {
          headers: [
            { key: 'List-Unsubscribe', value: '<http://unsub.acme-esp.example/u?id=1>' },
            { key: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
          ],
        },
      ],
    ]);
    const requestPublicHttps = vi.fn().mockResolvedValue({ status: 204 });
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe' },
      unsubscribeDeps({ requestPublicHttps }),
    );

    expect(requestPublicHttps).not.toHaveBeenCalled();
    expect((await response.json()).method).not.toBe('one-click');
  });

  test('hands the client a mailto: URI when Resend is not configured', async () => {
    const sql = createMockSql([
      [
        {
          headers: [{ key: 'List-Unsubscribe', value: '<mailto:unsub@example.com?subject=stop>' }],
        },
      ],
    ]);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe' },
      unsubscribeDeps(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'manual',
      method: 'mailto',
      mailto: 'mailto:unsub@example.com?subject=stop',
    });
  });

  test('404s when the message is not the caller’s', async () => {
    const sql = createMockSql([[]]);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe' },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(404);
  });

  test('422s when the message has no unsubscribe information', async () => {
    const sql = createMockSql([[{ headers: [] }]]);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe' },
      unsubscribeDeps(),
    );
    expect(response.status).toBe(422);
  });
});

describe('postMessage — AI unsubscribe tier', () => {
  const LINK_URL = 'https://news.example.com/u?id=1';
  const linkOnlyRows = () => [
    [
      {
        headers: [{ key: 'List-Unsubscribe', value: `<${LINK_URL}>` }],
        recipients: { to: [{ name: 'User', address: 'user@cookie.example' }] },
      },
    ],
  ];

  test('runs the AI attempt for link-only senders when the client opts in', async () => {
    const aiUnsubscribe = vi.fn().mockResolvedValue({ ok: true });
    const response = await postMessage(
      createMockSql(linkOnlyRows()),
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe', allow_ai: true },
      unsubscribeDeps({ aiUnsubscribe }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'unsubscribed', method: 'ai' });
    expect(aiUnsubscribe).toHaveBeenCalledWith({
      url: LINK_URL,
      recipientEmail: 'user@cookie.example',
    });
  });

  test('reports ai_failed (still carrying the url) when the attempt fails', async () => {
    const aiUnsubscribe = vi.fn().mockResolvedValue({ ok: false, reason: 'unconfirmed' });
    const response = await postMessage(
      createMockSql(linkOnlyRows()),
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe', allow_ai: true },
      unsubscribeDeps({ aiUnsubscribe }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ai_failed', method: 'ai', url: LINK_URL });
  });

  test('keeps the manual contract when the client did not opt in', async () => {
    const aiUnsubscribe = vi.fn();
    const response = await postMessage(
      createMockSql(linkOnlyRows()),
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe' },
      unsubscribeDeps({ aiUnsubscribe }),
    );

    expect(aiUnsubscribe).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ status: 'manual', method: 'link', url: LINK_URL });
  });

  test('keeps the manual contract when AI is not configured', async () => {
    const response = await postMessage(
      createMockSql(linkOnlyRows()),
      USER_ID,
      { id: MESSAGE_ID, action: 'unsubscribe', allow_ai: true },
      unsubscribeDeps(),
    );

    expect(await response.json()).toEqual({ status: 'manual', method: 'link', url: LINK_URL });
  });
});

describe('recipientAddress', () => {
  test('returns the first to-address from the jsonb shape', () => {
    expect(
      recipientAddress({ to: [{ name: 'User', address: 'user@cookie.example' }], cc: [] }),
    ).toBe('user@cookie.example');
  });

  test('handles double-encoded recipients from old ingest rows', () => {
    expect(recipientAddress(JSON.stringify({ to: [{ address: 'user@cookie.example' }] }))).toBe(
      'user@cookie.example',
    );
  });

  test('returns null for unexpected shapes and non-addresses', () => {
    expect(recipientAddress(null)).toBeNull();
    expect(recipientAddress({})).toBeNull();
    expect(recipientAddress({ to: [] })).toBeNull();
    expect(recipientAddress({ to: [{ address: 'not-an-email' }] })).toBeNull();
    expect(recipientAddress('not json')).toBeNull();
  });
});

describe('getMessage', () => {
  test('returns only a thread summary tied to the newest live message', () => {
    const sql = createMockSql();

    fetchOwnedMessageBody(sql, MESSAGE_ID, USER_ID);

    expect(sql.calls[0].text).toContain('t.ai_summary_message_id = latest.id');
    expect(sql.calls[0].text).toContain('THEN t.ai_summary ELSE NULL END AS thread_summary');
    expect(sql.calls[0].text).toContain('latest.id AS thread_latest_message_id');
    expect(sql.calls[0].text).toContain('NOT newest.is_deleted');
    expect(sql.calls[0].text).not.toContain('ai.summary');
  });

  test('adds a normalized calendar invite without exposing the private Blob URL', async () => {
    const ics = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:booking\nDTSTART:20260902T150000Z\nDTEND:20260902T153000Z\nSUMMARY:Whitburn Recycling Centre\nEND:VEVENT\nEND:VCALENDAR\n`;
    const readBlob = vi.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ics));
          controller.close();
        },
      }),
    });
    const sql = createMockSql([
      [{ id: MESSAGE_ID, thread_id: null, body_html: '<p>Booking</p>', headers: [] }],
      [
        {
          id: 'att-1',
          filename: 'booking.ics',
          content_type: 'text/calendar',
          size_bytes: 250,
          blob_url: 'https://store.private.blob.vercel-storage.com/booking.ics',
          downloadable: true,
        },
      ],
    ]);

    const response = await getMessage(sql, USER_ID, MESSAGE_ID, { readBlob });
    const body = await response.json();

    expect(body.calendar_invite).toEqual({
      title: 'Whitburn Recycling Centre',
      description: null,
      location: null,
      start_at: '2026-09-02T15:00:00.000Z',
      end_at: '2026-09-02T15:30:00.000Z',
    });
    expect(body.attachments[0].blob_url).toBeUndefined();
    expect(readBlob).toHaveBeenCalledWith(
      'https://store.private.blob.vercel-storage.com/booking.ics',
    );
  });

  test('returns the message body plus its thread history and attachments, with headers stripped', async () => {
    const sql = createMockSql([
      [
        {
          id: MESSAGE_ID,
          thread_id: 'thread-1',
          thread_muted: true,
          thread_summary: 'The revised plan is ready for approval.',
          thread_latest_message_id: MESSAGE_ID,
          body_html: '<p>Hi</p>',
          body_text: 'Hi',
          headers: [],
        },
      ],
      [
        {
          id: 'earlier-id',
          from_name: 'Alice',
          snippet: 'Earlier message',
          sent_at: '2026-01-01T00:00:00Z',
        },
        { id: MESSAGE_ID, from_name: 'Bob', snippet: 'Hi', sent_at: '2026-01-02T00:00:00Z' },
      ],
      [
        {
          id: 'att-1',
          filename: 'plan.pdf',
          content_type: 'application/pdf',
          size_bytes: 1024,
          downloadable: true,
        },
      ],
    ]);
    const response = await getMessage(sql, USER_ID, MESSAGE_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.body_html).toBe('<p>Hi</p>');
    expect(body.thread).toHaveLength(2);
    expect(body.thread_id).toBe('thread-1');
    expect(body.thread_muted).toBe(true);
    expect(body.thread_summary).toBe('The revised plan is ready for approval.');
    expect(body.thread_latest_message_id).toBe(MESSAGE_ID);
    expect(body.headers).toBeUndefined();
    expect(body.attachments).toEqual([
      {
        id: 'att-1',
        filename: 'plan.pdf',
        content_type: 'application/pdf',
        size_bytes: 1024,
        downloadable: true,
      },
    ]);
  });

  test('404s when the message does not exist or is not the caller’s', async () => {
    const sql = createMockSql([[]]);
    const response = await getMessage(sql, USER_ID, MESSAGE_ID);
    expect(response.status).toBe(404);
  });

  test('rejects a malformed id with 400', async () => {
    const sql = createMockSql();
    const response = await getMessage(sql, USER_ID, 'not-a-uuid');
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('getAttachment', () => {
  /** @param {any} [overrides] */
  function blobDeps(overrides = {}) {
    return {
      issueSignedToken: vi
        .fn()
        .mockResolvedValue({ clientSigningToken: 'a', delegationToken: 'b' }),
      presignUrl: vi
        .fn()
        .mockResolvedValue({ presignedUrl: 'https://blob.vercel-storage.com/signed' }),
      getDownloadUrl: vi.fn((url) => `${url}?download=1`),
      token: 'blob-token',
      ...overrides,
    };
  }

  test('issues a signed download URL for an owned attachment', async () => {
    const sql = createMockSql([
      [
        {
          filename: 'plan.pdf',
          content_type: 'application/pdf',
          blob_url: 'https://store123.private.blob.vercel-storage.com/plan.pdf',
        },
      ],
    ]);
    const response = await getAttachment(sql, USER_ID, ATTACHMENT_ID, blobDeps());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(body).toEqual({
      url: 'https://blob.vercel-storage.com/signed?download=1',
      filename: 'plan.pdf',
      contentType: 'application/pdf',
    });
  });

  test('404s when the attachment has no blob URL', async () => {
    const sql = createMockSql([[{ filename: 'x', content_type: 'x', blob_url: null }]]);
    const response = await getAttachment(sql, USER_ID, ATTACHMENT_ID, blobDeps());
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  test('rejects a malformed id with 400, still carrying the no-store header', async () => {
    const sql = createMockSql();
    const response = await getAttachment(sql, USER_ID, 'not-a-uuid', blobDeps());
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(sql).not.toHaveBeenCalled();
  });

  test('500s and does not leak details when signing fails', async () => {
    const sql = createMockSql([
      [
        {
          filename: 'plan.pdf',
          content_type: 'application/pdf',
          blob_url: 'https://store123.private.blob.vercel-storage.com/plan.pdf',
        },
      ],
    ]);
    const response = await getAttachment(
      sql,
      USER_ID,
      ATTACHMENT_ID,
      blobDeps({
        issueSignedToken: vi.fn().mockRejectedValue(new Error('blob API down')),
      }),
    );
    expect(response.status).toBe(500);
  });
});

describe('patchMessage', () => {
  test('updates flags on an owned message', async () => {
    const sql = createMockSql([
      [
        {
          id: MESSAGE_ID,
          is_unread: false,
          is_starred: true,
          is_archived: false,
          is_deleted: false,
          scheduled_for: null,
        },
      ],
    ]);
    const response = await patchMessage(sql, USER_ID, { id: MESSAGE_ID, is_starred: true });
    expect(response.status).toBe(200);
    expect((await response.json()).message.is_starred).toBe(true);
  });

  test('rejects a request with no id', async () => {
    const sql = createMockSql();
    const response = await patchMessage(sql, USER_ID, { is_starred: true });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('rejects a request with no actual change', async () => {
    const sql = createMockSql();
    const response = await patchMessage(sql, USER_ID, { id: MESSAGE_ID });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('rejects a non-boolean flag', async () => {
    const sql = createMockSql();
    const response = await patchMessage(sql, USER_ID, { id: MESSAGE_ID, is_starred: 'yes' });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('rejects an unparseable scheduled_for', async () => {
    const sql = createMockSql();
    const response = await patchMessage(sql, USER_ID, {
      id: MESSAGE_ID,
      scheduled_for: 'not-a-date',
    });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('404s when the message is not the caller’s', async () => {
    const sql = createMockSql([[]]);
    const response = await patchMessage(sql, USER_ID, { id: MESSAGE_ID, is_starred: true });
    expect(response.status).toBe(404);
  });

  // is_spam is the user's own verdict. It lives in message_ai.spam_verdict —
  // the column the Spam folder, unread badge, digest and search index already
  // read — so the request runs as a transaction: the ownership-checked
  // UPDATE first, then the verdict upsert stamped provider = 'user', then the
  // system "Spam" label so the row looks like AI-flagged spam.
  describe('is_spam', () => {
    const SPAM_LABEL_ID = '44444444-4444-4444-4444-444444444444';

    test('reports spam inside a transaction and pins the Spam label', async () => {
      const sql = createMockSql([
        [{ id: MESSAGE_ID, is_unread: true }], // ownership-checked UPDATE
        [], // message_ai upsert
        [{ id: SPAM_LABEL_ID }], // system Spam label upsert
        [], // message_labels insert
      ]);
      const response = await patchMessage(sql, USER_ID, { id: MESSAGE_ID, is_spam: true });

      expect(response.status).toBe(200);
      expect((await response.json()).message).toEqual({
        id: MESSAGE_ID,
        is_unread: true,
        is_spam: true,
      });
      expect(sql.begin).toHaveBeenCalledTimes(1);
      const texts = sql.calls.map((call) => call.text);
      expect(texts[0]).toMatch(/UPDATE messages m SET/);
      expect(texts[0]).toMatch(/search_indexed_at = NULL/);
      expect(texts[1]).toMatch(/INSERT INTO message_ai/);
      expect(texts[1]).toMatch(/ON CONFLICT \(message_id\) DO UPDATE/);
      expect(texts[1]).toMatch(/provider = 'user'/);
      expect(sql.calls[1].values).toContain('spam');
      expect(texts[2]).toMatch(/INSERT INTO labels/);
      expect(texts[2]).toContain("'Spam', '#64748b', 'system'");
      expect(texts[3]).toMatch(/INSERT INTO message_labels/);
      expect(sql.calls[3].values).toContain(SPAM_LABEL_ID);
    });

    test('clearing spam writes an inbox verdict and drops the Spam label', async () => {
      const sql = createMockSql([
        [{ id: MESSAGE_ID }], // ownership-checked UPDATE
        [], // message_ai upsert
        [], // Spam label removal
      ]);
      const response = await patchMessage(sql, USER_ID, { id: MESSAGE_ID, is_spam: false });

      expect(response.status).toBe(200);
      expect((await response.json()).message.is_spam).toBe(false);
      expect(sql.calls[1].values).toContain('inbox');
      expect(sql.calls[2].text).toMatch(/DELETE FROM message_labels/);
      expect(sql.calls[2].text).toContain("l.name = 'Spam'");
      expect(sql.calls).toHaveLength(3);
    });

    test('never writes a verdict for a message the caller does not own', async () => {
      const onMessageChanged = vi.fn();
      const sql = createMockSql([[]]);
      const response = await patchMessage(
        sql,
        USER_ID,
        { id: MESSAGE_ID, is_spam: true },
        { onMessageChanged },
      );

      expect(response.status).toBe(404);
      expect(sql.calls).toHaveLength(1);
      expect(onMessageChanged).not.toHaveBeenCalled();
    });

    test('reindexes the message after the verdict lands', async () => {
      const onMessageChanged = vi.fn();
      const sql = createMockSql([[{ id: MESSAGE_ID }], [], []]);
      await patchMessage(sql, USER_ID, { id: MESSAGE_ID, is_spam: false }, { onMessageChanged });
      expect(onMessageChanged).toHaveBeenCalledWith(MESSAGE_ID);
    });

    test('rejects a non-boolean is_spam', async () => {
      const sql = createMockSql();
      const response = await patchMessage(sql, USER_ID, { id: MESSAGE_ID, is_spam: 'yes' });
      expect(response.status).toBe(400);
      expect(sql).not.toHaveBeenCalled();
    });

    test('flag-only requests stay a single statement outside a transaction', async () => {
      const sql = createMockSql([[{ id: MESSAGE_ID }]]);
      await patchMessage(sql, USER_ID, { id: MESSAGE_ID, is_starred: true });
      expect(sql.begin).not.toHaveBeenCalled();
      expect(sql.calls).toHaveLength(1);
    });
  });
});

// is_unread/is_starred/is_archived/is_deleted/scheduled_for and the label set
// are all part of a message's Meilisearch document, so every write that
// changes one has to invalidate the index two ways: search_indexed_at = NULL
// for the background drift sweep, and onMessageChanged for the immediate
// best-effort sync. A write that changed nothing must do neither.
describe('search index invalidation', () => {
  /** @param {any} sql */
  const queries = (sql) => sql.calls.map((/** @type {{text: string}} */ c) => c.text);

  test('patchMessage clears search_indexed_at in the same UPDATE', async () => {
    const sql = createMockSql([[{ id: MESSAGE_ID }]]);
    await patchMessage(sql, USER_ID, { id: MESSAGE_ID, is_archived: true });
    expect(sql.calls[0].text).toMatch(/UPDATE messages m SET/);
    expect(sql.calls[0].text).toMatch(/search_indexed_at = NULL/);
  });

  test('patchMessage reindexes the message it updated', async () => {
    const onMessageChanged = vi.fn();
    const sql = createMockSql([[{ id: MESSAGE_ID }]]);
    await patchMessage(sql, USER_ID, { id: MESSAGE_ID, is_archived: true }, { onMessageChanged });
    expect(onMessageChanged).toHaveBeenCalledWith(MESSAGE_ID);
  });

  test('patchMessage does not reindex when no row matched', async () => {
    const onMessageChanged = vi.fn();
    const sql = createMockSql([[]]); // someone else's id, or one that no longer exists
    const response = await patchMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, is_archived: true },
      { onMessageChanged },
    );
    expect(response.status).toBe(404);
    expect(onMessageChanged).not.toHaveBeenCalled();
  });

  test('adding a label marks the message drifted and reindexes it', async () => {
    const onMessageChanged = vi.fn();
    const sql = createMockSql([
      [{ label_id: LABEL_ID }], // INSERT ... RETURNING
      [], // drift mark
      [{ name: 'Work', color: '#3b82f6', kind: 'user' }], // labels read-back
    ]);
    await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'add_label', label_id: LABEL_ID },
      unsubscribeDeps({ onMessageChanged }),
    );
    expect(queries(sql)).toContainEqual(
      expect.stringMatching(/UPDATE messages SET search_indexed_at = NULL WHERE id = /),
    );
    expect(sql.calls[1].values).toEqual([MESSAGE_ID]);
    expect(onMessageChanged).toHaveBeenCalledWith(MESSAGE_ID);
  });

  test('removing a label marks the message drifted and reindexes it', async () => {
    const onMessageChanged = vi.fn();
    const sql = createMockSql([
      [{ label_id: LABEL_ID }], // DELETE ... RETURNING
      [], // drift mark
      [], // labels read-back
    ]);
    await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'remove_label', label_id: LABEL_ID },
      unsubscribeDeps({ onMessageChanged }),
    );
    expect(queries(sql)).toContainEqual(
      expect.stringMatching(/UPDATE messages SET search_indexed_at = NULL WHERE id = /),
    );
    expect(sql.calls[1].values).toEqual([MESSAGE_ID]);
    expect(onMessageChanged).toHaveBeenCalledWith(MESSAGE_ID);
  });

  test('the join-table write and the drift mark share one transaction', async () => {
    const sql = createMockSql([
      [{ label_id: LABEL_ID }], // INSERT ... RETURNING
      [], // drift mark
      [{ name: 'Work', color: '#3b82f6', kind: 'user' }], // labels read-back
    ]);
    /** @type {string[]} */
    const inTransaction = [];
    sql.begin = vi.fn(async (/** @type {(tx: any) => unknown} */ callback) => {
      const before = sql.calls.length;
      const result = await callback(sql);
      inTransaction.push(...sql.calls.slice(before).map((/** @type {any} */ c) => c.text));
      return result;
    });
    await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'add_label', label_id: LABEL_ID },
      unsubscribeDeps(),
    );
    expect(sql.begin).toHaveBeenCalledOnce();
    expect(inTransaction.join('\n')).toMatch(/INSERT INTO message_labels/);
    expect(inTransaction.join('\n')).toMatch(/UPDATE messages SET search_indexed_at = NULL/);
    // The labels read-back is not part of the write, so it stays outside.
    expect(inTransaction.join('\n')).not.toMatch(/JOIN labels l/);
  });

  // Search bookkeeping must never break a mail mutation. Because the mark is
  // inside the transaction, a mark that fails rolls the label write back with
  // it: the caller's 500 then describes a change that genuinely did not happen,
  // instead of a committed one they will see on their next refresh.
  test('a failing drift mark rolls the label write back rather than half-applying', async () => {
    const onMessageChanged = vi.fn();
    /** Writes that survived. @type {string[]} */
    const durable = [];
    /** @param {string[]} sink */
    const handle = (sink) =>
      vi.fn((/** @type {TemplateStringsArray} */ strings) => {
        const text = strings.join('?');
        if (/search_indexed_at/.test(text)) return Promise.reject(new Error('connection reset'));
        sink.push(text);
        if (/INSERT INTO message_labels/.test(text)) {
          return Promise.resolve([{ label_id: LABEL_ID }]);
        }
        return Promise.resolve([]);
      });
    /** Anything run off `sql` itself is autocommitted. @type {any} */
    const sql = handle(durable);
    // postgres.js rolls back and rethrows when the callback rejects, so writes
    // staged inside it never become durable.
    sql.begin = vi.fn(async (/** @type {(tx: any) => unknown} */ callback) => {
      /** @type {string[]} */
      const staged = [];
      const result = await callback(handle(staged));
      durable.push(...staged);
      return result;
    });

    await expect(
      postMessage(
        sql,
        USER_ID,
        { id: MESSAGE_ID, action: 'add_label', label_id: LABEL_ID },
        unsubscribeDeps({ onMessageChanged }),
      ),
    ).rejects.toThrow('connection reset');
    // The label change went down with the mark: the 500 the caller gets is
    // honest, not a report on a change that had already committed.
    expect(durable.join('\n')).not.toMatch(/message_labels/);
    // And nothing was queued for sync on a write that never landed.
    expect(onMessageChanged).not.toHaveBeenCalled();
  });

  test('a no-op label mutation neither marks nor reindexes', async () => {
    const onMessageChanged = vi.fn();
    const sql = createMockSql([
      [], // duplicate add: ON CONFLICT DO NOTHING returned no row
      [{ message: true, label: true }], // both are the caller's, so this is a 200 no-op
      [{ name: 'Work', color: '#3b82f6', kind: 'user' }], // labels read-back
    ]);
    const response = await postMessage(
      sql,
      USER_ID,
      { id: MESSAGE_ID, action: 'add_label', label_id: LABEL_ID },
      unsubscribeDeps({ onMessageChanged }),
    );
    expect(response.status).toBe(200);
    expect(queries(sql).join('\n')).not.toMatch(/search_indexed_at/);
    expect(onMessageChanged).not.toHaveBeenCalled();
  });
});

describe('fetchMessageAttachments', () => {
  test('reads the attachments table scoped to the message, ordered by filename', () => {
    /** @type {string} */
    let query = '';
    /** @type {unknown[]} */
    const values = [];
    const sql = (/** @type {TemplateStringsArray} */ strings, /** @type {unknown[]} */ ...vals) => {
      query = strings.join('?');
      values.push(...vals);
      return [];
    };

    fetchMessageAttachments(/** @type {any} */ (sql), MESSAGE_ID);

    expect(query).toContain('FROM attachments');
    expect(query).toContain('blob_url IS NOT NULL');
    expect(query).toContain('WHERE message_id =');
    expect(query).toContain('ORDER BY filename');
    expect(values).toEqual([MESSAGE_ID]);
  });
});

describe('fetchThreadMessages', () => {
  test('returns thread metadata without full bodies', () => {
    /** @type {string} */
    let query = '';
    const sql = (/** @type {TemplateStringsArray} */ strings) => {
      query = strings.join('?');
      return [];
    };

    fetchThreadMessages(/** @type {any} */ (sql), 'thread-1', USER_ID);

    expect(query).toContain('m.snippet');
    expect(query).toContain('NOT m.is_deleted');
    expect(query).toContain('LIMIT');
    expect(query).not.toContain('m.body_text');
  });
});

// getAttachment reports its own failures as a 500, but a dropped connection
// is the worker's to retry on a fresh one, so that one is let through.
describe('getAttachment on a dropped connection', () => {
  test('rethrows a transient database error instead of answering 500', async () => {
    const sql = /** @type {any} */ (() => Promise.reject(new Error('Network connection lost.')));
    const blob = /** @type {any} */ ({});
    await expect(
      getAttachment(sql, 'user-1', '11111111-1111-1111-1111-111111111111', blob),
    ).rejects.toThrow('Network connection lost');
  });
});
