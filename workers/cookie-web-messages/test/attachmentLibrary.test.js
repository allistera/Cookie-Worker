import { describe, expect, test, vi } from 'vitest';
import { ATTACHMENT_PAGE_SIZE, getAttachmentLibrary } from '../src/attachmentLibrary.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-4999-8999-999999999999';
const ATTACHMENT_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';

/** @param {string} [query] */
const libraryUrl = (query = '') => new URL(`https://messages.example/messages/attachments${query}`);

/** @param {Record<string, unknown>} [overrides] */
function receivedRow(overrides = {}) {
  return {
    id: ATTACHMENT_ID,
    filename: 'invoice-1042.pdf',
    content_type: 'application/pdf',
    size_bytes: '204800',
    downloadable: true,
    embedded: false,
    message_id: MESSAGE_ID,
    subject: 'Your November invoice',
    is_sent: false,
    from_name: 'Northwind Billing',
    from_address: 'billing@northwind.example',
    is_unread: false,
    is_starred: true,
    is_archived: false,
    sent_to: null,
    sent_at: '2026-11-20T08:00:00.123Z',
    sent_cursor: '2026-11-20T08:00:00.123456Z',
    ...overrides,
  };
}

describe('getAttachmentLibrary', () => {
  test('lists a received file with its email and sender', async () => {
    const sql = createMockSql([[receivedRow()]]);
    const response = await getAttachmentLibrary(sql, USER_ID, libraryUrl());

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      attachments: [
        {
          id: ATTACHMENT_ID,
          filename: 'invoice-1042.pdf',
          contentType: 'application/pdf',
          sizeBytes: 204800,
          downloadable: true,
          embedded: false,
          direction: 'received',
          messageId: MESSAGE_ID,
          subject: 'Your November invoice',
          correspondent: {
            name: 'Northwind Billing',
            address: 'billing@northwind.example',
            others: 0,
          },
          date: '2026-11-20T08:00:00.123Z',
          unread: false,
          starred: true,
          archived: false,
        },
      ],
      nextCursor: null,
    });
    // Both directions, embedded pictures left out, no cursor, one extra row
    // asked for to learn whether another page follows.
    expect(sql.calls[0].values).toEqual([
      USER_ID,
      null,
      null,
      false,
      null,
      null,
      null,
      ATTACHMENT_PAGE_SIZE + 1,
    ]);
  });

  test('names the first recipient of a sent file and counts the others', async () => {
    const sql = createMockSql([
      [
        receivedRow({
          is_sent: true,
          from_name: 'Me',
          from_address: 'me@example.com',
          sent_to: [
            { address: 'sam@example.com', name: 'Sam Carter' },
            { address: 'lee@example.com', name: null },
            { address: '  ' },
          ],
        }),
      ],
    ]);
    const { attachments } = await (
      await getAttachmentLibrary(sql, USER_ID, libraryUrl('?direction=sent'))
    ).json();

    expect(attachments[0].direction).toBe('sent');
    expect(attachments[0].correspondent).toEqual({
      name: 'Sam Carter',
      address: 'sam@example.com',
      others: 1,
    });
    expect(sql.calls[0].values.slice(1, 3)).toEqual(['sent', 'sent']);
  });

  test('reports no correspondent when the mail names nobody', async () => {
    const sql = createMockSql([
      [
        receivedRow({ from_name: null, from_address: null }),
        receivedRow({ is_sent: true, sent_to: 'not a list' }),
      ],
    ]);
    const { attachments } = await (await getAttachmentLibrary(sql, USER_ID, libraryUrl())).json();

    expect(attachments.map((/** @type {any} */ entry) => entry.correspondent)).toEqual([
      null,
      null,
    ]);
  });

  test('passes on a file with no name, type, size or stored bytes as it is', async () => {
    const sql = createMockSql([
      [
        receivedRow({
          filename: null,
          content_type: '',
          size_bytes: null,
          downloadable: false,
          subject: '',
        }),
      ],
    ]);
    const { attachments } = await (await getAttachmentLibrary(sql, USER_ID, libraryUrl())).json();

    expect(attachments[0]).toMatchObject({
      filename: null,
      contentType: null,
      sizeBytes: null,
      downloadable: false,
      subject: null,
    });
  });

  test('never returns where the bytes are stored', async () => {
    const sql = createMockSql([
      [receivedRow({ blob_url: 'https://store.private.blob.vercel-storage.com/secret.pdf' })],
    ]);
    const body = await (await getAttachmentLibrary(sql, USER_ID, libraryUrl())).text();

    expect(body).not.toContain('vercel-storage');
    expect(body).not.toContain('blob_url');
  });

  test('includes pictures from email bodies only when asked', async () => {
    const sql = createMockSql([[receivedRow({ embedded: true, content_type: 'image/png' })]]);
    const { attachments } = await (
      await getAttachmentLibrary(sql, USER_ID, libraryUrl('?embedded=1'))
    ).json();

    expect(attachments[0].embedded).toBe(true);
    expect(sql.calls[0].values[3]).toBe(true);
  });

  test('offers a cursor that keeps the microseconds when another page follows', async () => {
    const rows = Array.from({ length: ATTACHMENT_PAGE_SIZE + 1 }, (_, index) =>
      receivedRow({ id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}` }),
    );
    const sql = createMockSql([rows]);
    const { attachments, nextCursor } = await (
      await getAttachmentLibrary(sql, USER_ID, libraryUrl())
    ).json();

    expect(attachments).toHaveLength(ATTACHMENT_PAGE_SIZE);
    expect(nextCursor).toBe('2026-11-20T08:00:00.123456Z|33333333-3333-4333-8333-000000000099');
  });

  test('continues from the cursor of the previous page', async () => {
    const sql = createMockSql([[]]);
    const cursor = `2026-11-20T08:00:00.123456Z|${ATTACHMENT_ID}`;
    const response = await getAttachmentLibrary(
      sql,
      USER_ID,
      libraryUrl(`?before=${encodeURIComponent(cursor)}`),
    );

    expect(await response.json()).toEqual({ attachments: [], nextCursor: null });
    expect(sql.calls[0].values.slice(4, 7)).toEqual([
      '2026-11-20T08:00:00.123456Z',
      '2026-11-20T08:00:00.123456Z',
      ATTACHMENT_ID,
    ]);
  });

  test.each([
    '?direction=drafts',
    '?before=yesterday',
    `?before=2026-13-45T99:00:00Z|${ATTACHMENT_ID}`,
  ])('answers 400 to %s without reading the mailbox', async (query) => {
    const sql = createMockSql();
    const response = await getAttachmentLibrary(sql, USER_ID, libraryUrl(query));

    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('answers 500 when the read fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sql = createMockSql();
    sql.mockImplementationOnce(() => Promise.reject(new Error('syntax error')));
    const response = await getAttachmentLibrary(sql, USER_ID, libraryUrl());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to load attachments' });
    log.mockRestore();
  });

  test('leaves a dropped connection to the Worker to retry', async () => {
    const sql = createMockSql();
    sql.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' }),
      ),
    );

    await expect(getAttachmentLibrary(sql, USER_ID, libraryUrl())).rejects.toThrow(
      'CONNECTION_CLOSED',
    );
  });
});
