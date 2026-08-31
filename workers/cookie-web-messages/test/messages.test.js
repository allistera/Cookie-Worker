import { describe, expect, test, vi } from 'vitest';
import {
  fetchMessageAttachments,
  fetchThreadMessages,
  getAttachment,
  getMessage,
  getThreadBody,
  patchMessage,
  postMessage,
} from '../src/messages.js';
import { createMockSql } from './helpers.js';

vi.mock('../../../shared/rate-limit.js', () => ({
  allowRequest: vi.fn().mockResolvedValue(true),
}));

const USER_ID = '99999999-9999-4999-8999-999999999999';
const MESSAGE_ID = '11111111-1111-1111-1111-111111111111';
const LABEL_ID = '22222222-2222-2222-2222-222222222222';
const ATTACHMENT_ID = '33333333-3333-3333-3333-333333333333';

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

  test('skips the server-side POST for hosts outside the one-click allowlist', async () => {
    const sql = createMockSql([
      [
        {
          headers: [
            { key: 'List-Unsubscribe', value: '<https://attacker.example/unsubscribe?id=123>' },
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

    // Falls through to the manual link — no server-side request is made.
    expect(requestPublicHttps).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      status: 'manual',
      method: 'link',
      url: 'https://attacker.example/unsubscribe?id=123',
    });
  });

  test('sends one-click to an operator-extended allowlist entry', async () => {
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
      unsubscribeDeps({ requestPublicHttps, oneClickAllowlist: ['acme-esp.example'] }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'unsubscribed', method: 'one-click' });
    expect(requestPublicHttps).toHaveBeenCalledTimes(1);
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

describe('getMessage', () => {
  test('returns the message body plus its thread history and attachments, with headers stripped', async () => {
    const sql = createMockSql([
      [
        {
          id: MESSAGE_ID,
          thread_id: 'thread-1',
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

describe('getThreadBody', () => {
  test('returns one owned thread message body on demand', async () => {
    const sql = createMockSql([[{ body_text: 'Earlier complete body' }]]);
    const response = await getThreadBody(sql, USER_ID, MESSAGE_ID);
    expect(await response.json()).toEqual({ body_text: 'Earlier complete body' });
  });

  test('404s when the message is not found', async () => {
    const sql = createMockSql([[]]);
    const response = await getThreadBody(sql, USER_ID, MESSAGE_ID);
    expect(response.status).toBe(404);
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
