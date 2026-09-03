import { describe, expect, test } from 'vitest';
import { fetchEmails, fetchUnreadCount, handleList, handleState } from '../src/emails.js';

// Ported from Cookie-Web's api/__tests__/emails.test.js — same scripted
// results, same expected statuses and payloads, plus the validation branches
// that were only covered indirectly there.

const USER_ID = '11111111-1111-4111-8111-111111111111';

// Both queries resolve through the same stub; handleList only cares that
// fetchEmails returns an array of rows.
/** @param {unknown[]} rows @returns {any} */
function stubSql(rows = []) {
  const sql = () => Promise.resolve(rows);
  return sql;
}

/** @param {string} query */
function listUrl(query = '') {
  return new URL(`https://emails.example/emails${query}`);
}

describe('handleList', () => {
  test('returns the first page with unread count and userId', async () => {
    const response = await handleList(stubSql(), USER_ID, listUrl('?limit=50'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      emails: [],
      nextCursor: null,
      readReceiptsAvailable: false,
      unreadCount: 0,
      spamCount: 0,
      snoozedCount: 0,
      userId: USER_ID,
    });
  });

  test('returns cursor pages without the unread aggregate instead of crashing', async () => {
    const before = encodeURIComponent(
      '2026-07-01T00:00:00.000Z|11111111-1111-1111-1111-111111111111',
    );
    const response = await handleList(stubSql(), USER_ID, listUrl(`?limit=50&before=${before}`));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ emails: [], nextCursor: null });
    expect(body).not.toHaveProperty('unreadCount');
    expect(body).not.toHaveProperty('spamCount');
    expect(body).not.toHaveProperty('snoozedCount');
    expect(body).not.toHaveProperty('userId');
  });

  test('pages by handing back the last row as the next cursor', async () => {
    const rows = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        sent_at: new Date('2026-07-02T00:00:00Z'),
        sort_at: new Date('2026-08-02T00:00:00Z'),
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        sent_at: new Date('2026-08-01T00:00:00Z'),
        sort_at: new Date('2026-08-01T00:00:00Z'),
      },
    ];
    const response = await handleList(stubSql(rows), USER_ID, listUrl('?limit=1'));

    const body = await response.json();
    expect(body.emails).toHaveLength(1);
    expect(body.emails[0]).not.toHaveProperty('sort_at');
    expect(body.nextCursor).toBe('2026-08-02T00:00:00.000Z|11111111-1111-4111-8111-111111111111');
  });

  test('flags read receipts as available only for the sent folder', async () => {
    const response = await handleList(stubSql(), USER_ID, listUrl('?folder=sent'));
    expect((await response.json()).readReceiptsAvailable).toBe(true);
  });

  test.each([
    ['an unknown folder', '?folder=trash'],
    ['the label folder without a label', '?folder=label'],
    ['a malformed before cursor', '?before=nonsense'],
  ])('rejects %s with a 400', async (_name, query) => {
    const response = await handleList(stubSql(), USER_ID, listUrl(query));
    expect(response.status).toBe(400);
  });

  test('answers 500 without leaking details when the query fails', async () => {
    // Throws synchronously: fetchEmails interpolates nested sql`` fragments
    // whose promises are never awaited, so a rejecting stub would leak
    // unhandled rejections that fail the suite in CI.
    const sql = () => {
      throw new Error('connection reset');
    };
    const response = await handleList(/** @type {any} */ (sql), USER_ID, listUrl());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to load emails' });
  });
});

describe('handleState', () => {
  test('returns lightweight inbox state without a message list', async () => {
    const response = await handleState(stubSql([{ unread: 7 }]), USER_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      unreadCount: 7,
      spamCount: 0,
      snoozedCount: 0,
      userId: USER_ID,
    });
  });

  // The sidebar only lists Spam and Snoozed while those folders hold
  // something, so the counts have to arrive with the bootstrap, before either
  // folder is ever opened.
  test('reports how many messages the Spam and Snoozed folders hold', async () => {
    const rows = [{ unread: 7, spam: 2, snoozed: 3 }];
    const response = await handleState(stubSql(rows), USER_ID);

    expect(await response.json()).toEqual({
      unreadCount: 7,
      spamCount: 2,
      snoozedCount: 3,
      userId: USER_ID,
    });
  });

  test('answers 500 without leaking details when the query fails', async () => {
    const sql = () => Promise.reject(new Error('connection reset'));
    const response = await handleState(/** @type {any} */ (sql), USER_ID);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to load inbox state' });
  });
});

describe('fetchEmails', () => {
  test('includes a has_attachments flag scoped to each message', () => {
    let query = '';
    // Fragment-aware capture: folderPredicate and the cursor conditional embed
    // nested sql`` fragments, which must splice into the text rather than
    // count as parameters.
    /** @type {any} */
    const sql = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => {
      query = strings.reduce((acc, part, i) => {
        if (i === 0) return part;
        const value = values[i - 1];
        if (value?.__frag) return acc + value.text + part;
        return `${acc}?${part}`;
      }, '');
      const frag = /** @type {any} */ ([]);
      frag.__frag = true;
      frag.text = query;
      return frag;
    };

    fetchEmails(sql, USER_ID, 50, null, 'inbox');

    expect(query).toContain(
      'EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments',
    );
    expect(query).toContain('WHERE m.user_id = ?');
    expect(query).not.toContain('body_text');
  });
});

describe('fetchUnreadCount', () => {
  test('keeps is_unread in the WHERE so the partial unread index applies', () => {
    let query = '';
    /** @type {any} */
    const sql = (/** @type {TemplateStringsArray} */ strings) => {
      query = strings.join('?');
      return [];
    };

    fetchUnreadCount(sql, USER_ID);

    // messages_unread_idx is a partial index ON messages (user_id) WHERE
    // is_unread — this predicate shape matches it directly.
    expect(query).toContain('WHERE m.user_id = ? AND m.is_unread');
    expect(query).toMatch(/FILTER \(\s*WHERE COALESCE\(ai\.spam_verdict, 'inbox'\) <> 'spam'\s*\)/);
  });
});
