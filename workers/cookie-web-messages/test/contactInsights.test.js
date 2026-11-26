import { describe, expect, test } from 'vitest';
import {
  getContactInsights,
  normalizeContactAddress,
  patchContactInsights,
} from '../src/contactInsights.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-4999-8999-999999999999';
const MESSAGE_ID = '11111111-1111-1111-1111-111111111111';

describe('contact insights', () => {
  test('normalizes a valid address and rejects malformed input', () => {
    expect(normalizeContactAddress(' Alex@Example.com ')).toBe('alex@example.com');
    expect(normalizeContactAddress('not-an-address')).toBeNull();
  });

  test('returns private profile data and newest-first history', async () => {
    const sql = createMockSql([
      [
        {
          name: 'Alex',
          company: 'Example Studio',
          role: 'Director',
          linkedin_url: 'https://www.linkedin.com/in/alex',
          notes: 'Prefers email',
        },
      ],
      [
        {
          id: MESSAGE_ID,
          subject: 'Project proposal',
          snippet: 'Thanks for sending this',
          sent_at: '2026-09-14T09:00:00.000Z',
          is_sent: false,
        },
      ],
    ]);
    const response = await getContactInsights(
      sql,
      USER_ID,
      new URL('https://example.test/messages/contact-insights?address=Alex%40Example.com'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      contact: {
        address: 'alex@example.com',
        name: 'Alex',
        company: 'Example Studio',
        role: 'Director',
        linkedinUrl: 'https://www.linkedin.com/in/alex',
        notes: 'Prefers email',
      },
      history: [
        {
          id: MESSAGE_ID,
          subject: 'Project proposal',
          snippet: 'Thanks for sending this',
          sent_at: '2026-09-14T09:00:00.000Z',
          is_sent: false,
        },
      ],
      nextCursor: null,
    });
  });

  test('pages history with a cursor that keeps microseconds', async () => {
    const OLDER_ID = '22222222-2222-4222-8222-222222222222';
    const row = (/** @type {string} */ id, /** @type {string} */ cursor) => ({
      id,
      sent_at: '2026-09-14T09:00:00.123Z',
      sent_cursor: cursor,
      is_sent: false,
    });
    const sql = createMockSql([
      [{}],
      [
        row(MESSAGE_ID, '2026-09-14T09:00:00.123456Z'),
        row(OLDER_ID, '2026-09-14T09:00:00.123001Z'),
      ],
    ]);
    const response = await getContactInsights(
      sql,
      USER_ID,
      new URL('https://example.test/messages/contact-insights?address=alex@example.com&limit=1'),
    );
    const body = await response.json();
    expect(body.history).toEqual([
      { id: MESSAGE_ID, sent_at: '2026-09-14T09:00:00.123Z', is_sent: false },
    ]);
    const next = JSON.parse(atob(body.nextCursor.replaceAll('-', '+').replaceAll('_', '/')));
    expect(next).toEqual(['2026-09-14T09:00:00.123456Z', MESSAGE_ID]);

    // The next page binds the cursor as text, so Postgres sees every digit.
    const nextSql = createMockSql([[{}], []]);
    await getContactInsights(
      nextSql,
      USER_ID,
      new URL(
        `https://example.test/messages/contact-insights?address=alex@example.com&before=${body.nextCursor}`,
      ),
    );
    const history = nextSql.calls[1];
    expect(history.text).toContain('(m.sent_at, m.id) < (?::text::timestamptz, ?::uuid)');
    expect(history.values).toContain('2026-09-14T09:00:00.123456Z');
  });

  test('scopes both history branches to the caller and derives has_html from body_html', async () => {
    const sql = createMockSql([[{}], []]);
    await getContactInsights(
      sql,
      USER_ID,
      new URL('https://example.test/messages/contact-insights?address=alex%40example.com&limit=5'),
    );

    const history = sql.calls[1];
    expect(history.text).toContain('UNION ALL');
    expect(history.text).toContain('m.body_html IS NOT NULL');
    expect(history.text).not.toContain('body_html_url');
    expect(history.values.filter((value) => value === USER_ID)).toHaveLength(2);
    expect(history.values.filter((value) => value === 'alex@example.com')).toHaveLength(2);
    expect(history.values.filter((value) => value === 6)).toHaveLength(3);
  });

  test('saves user-owned fields for the normalized address', async () => {
    const sql = createMockSql([
      [
        {
          company: 'Example Studio',
          role: 'Director',
          linkedin_url: 'https://linkedin.com/in/alex',
          notes: 'Private note',
        },
      ],
    ]);
    const response = await patchContactInsights(sql, USER_ID, {
      address: 'Alex@Example.com',
      company: ' Example Studio ',
      role: 'Director',
      linkedinUrl: 'https://linkedin.com/in/alex',
      notes: 'Private note',
    });

    expect(response.status).toBe(200);
    expect(sql.calls[0].values).toContain(USER_ID);
    expect(sql.calls[0].values).toContain('alex@example.com');
    expect((await response.json()).contact.notes).toBe('Private note');
  });

  test('rejects non-LinkedIn social URLs', async () => {
    const response = await patchContactInsights(createMockSql(), USER_ID, {
      address: 'alex@example.com',
      linkedinUrl: 'https://example.com/alex',
      notes: '',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Enter a valid LinkedIn URL');
  });
});
