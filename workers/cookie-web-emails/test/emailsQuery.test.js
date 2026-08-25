import { describe, expect, test } from 'vitest';
import { fetchEmails, fetchUnreadCount } from '../src/emails.js';

// Ported from Cookie-Web's api/_lib/__tests__/emails-query.test.js — the
// folder-predicate and query-shape suite, unchanged apart from moving with
// the queries.

function captureQuery() {
  let text = '';
  /** @type {any} */
  const sql = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => {
    text = strings.reduce((acc, part, i) => {
      if (i === 0) return part;
      const value = values[i - 1];
      if (value?.__frag) return acc + value.text + part;
      return `${acc}?${part}`;
    }, '');
    const frag = /** @type {any} */ ([]);
    frag.__frag = true;
    frag.text = text;
    return frag;
  };
  return { sql, query: () => text };
}

const USER_ID = '99999999-9999-4999-8999-999999999999';

describe('fetchEmails', () => {
  test.each([
    ['first page', null],
    [
      'cursor page',
      { sentAt: '2026-07-13T12:00:00.000Z', id: '11111111-1111-1111-1111-111111111111' },
    ],
  ])('groups joined AI fields for the %s query', (_name, cursor) => {
    const capture = captureQuery();

    fetchEmails(capture.sql, USER_ID, 50, cursor, 'inbox');

    expect(capture.query()).toContain('GROUP BY m.id, ai.spam_score');
    expect(capture.query()).toContain('ai.summary');
    expect(capture.query()).toContain('AS has_ai_summary');
    expect(capture.query()).toContain('m.scheduled_for');
    expect(capture.query()).toContain('m.scheduled_for IS NULL OR m.scheduled_for <= now()');
  });

  test('normalizes double-encoded recipients to a jsonb object, like the contacts view does', () => {
    const capture = captureQuery();

    fetchEmails(capture.sql, USER_ID, 50, null, 'inbox');

    expect(capture.query()).toContain("jsonb_typeof(m.recipients) = 'string'");
    expect(capture.query()).toContain("(m.recipients #>> '{}')::jsonb");
    expect(capture.query()).toContain('ELSE m.recipients END AS recipients');
  });

  test('does not transfer message bodies in list rows', () => {
    const capture = captureQuery();

    fetchEmails(capture.sql, USER_ID, 50, null, 'inbox');

    expect(capture.query()).not.toContain('body_text');
  });

  test.each([
    null,
    { sentAt: '2026-07-13T12:00:00.000Z', id: '11111111-1111-1111-1111-111111111111' },
  ])('selects only future scheduled messages for the snoozed folder', (cursor) => {
    const capture = captureQuery();

    fetchEmails(capture.sql, USER_ID, 50, cursor, 'snoozed');

    expect(capture.query()).toContain('m.scheduled_for > now()');
    expect(capture.query()).not.toContain("? = 'snoozed'");
    expect(capture.query()).toContain('GROUP BY m.id, ai.spam_score');
  });

  test.each([
    ['first page', null],
    [
      'cursor page',
      { sentAt: '2026-07-13T12:00:00.000Z', id: '11111111-1111-1111-1111-111111111111' },
    ],
  ])('selects archived messages for the Done %s query', (_name, cursor) => {
    const capture = captureQuery();

    fetchEmails(capture.sql, USER_ID, 50, cursor, 'done');

    expect(capture.query()).toContain('AND (m.is_archived)');
    expect(capture.query()).not.toContain("? = 'done'");
    expect(capture.query()).toContain('GROUP BY m.id, ai.spam_score');
  });

  test('inlines the inbox folder predicate so the 0035 partial index can apply', () => {
    const capture = captureQuery();

    fetchEmails(capture.sql, USER_ID, 50, null, 'inbox');

    expect(capture.query()).toContain('NOT m.is_archived AND NOT m.is_sent');
    expect(capture.query()).not.toContain("? = 'inbox'");
  });

  test('selects starred messages as a real folder rather than a client filter', () => {
    const capture = captureQuery();

    fetchEmails(capture.sql, USER_ID, 50, null, 'starred');

    expect(capture.query()).toContain('AND (m.is_starred)');
    expect(capture.query()).toContain('NOT m.is_deleted');
  });

  test('selects a named label folder via an existence subquery', () => {
    const capture = captureQuery();

    fetchEmails(capture.sql, USER_ID, 50, null, 'label', 'Invoices');

    expect(capture.query()).toContain('FROM message_labels tagged');
    expect(capture.query()).toContain('tagged_l.name = ?');
  });
});

describe('fetchUnreadCount', () => {
  // A bare aggregate (no GROUP BY) always returns exactly one row even when
  // zero messages match, so unlike the old users-anchored LEFT JOIN version,
  // this can scope directly off messages by the already-known userId and
  // still guarantee a row. is_unread stays in the WHERE, matching the
  // partial index messages_unread_idx; spam exclusion stays in the FILTER
  // since it depends on the joined message_ai row.
  test('excludes spam inside the aggregate filter, not the WHERE clause', () => {
    const capture = captureQuery();

    fetchUnreadCount(capture.sql, USER_ID);

    expect(capture.query()).toMatch(
      /count\(m\.id\) FILTER \(\s*WHERE COALESCE\(ai\.spam_verdict, 'inbox'\) <> 'spam'\s*\)/,
    );
    expect(capture.query()).toContain('WHERE m.user_id = ? AND m.is_unread');
    const whereOnwards = capture.query().slice(capture.query().indexOf('WHERE m.user_id'));
    expect(whereOnwards).not.toContain('spam');
  });
});
