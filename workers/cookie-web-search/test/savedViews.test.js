import { describe, expect, test } from 'vitest';

import {
  getSavedViews,
  putSavedViews,
  savedQueryError,
  savedViewsError,
} from '../src/savedViews.js';

const A = 'user-a';
const B = 'user-b';
const view = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Client mail',
  query: 'from:client@example.com has:attachment after:2026-09-01',
  folder: 'all',
};

function database() {
  /** @type {Map<string, {theme: string, savedSearchViews?: any}>} */
  const users = new Map([
    [A, { theme: 'dark' }],
    [B, { theme: 'light' }],
  ]);
  /** @type {string[]} */
  const queries = [];
  /** @type {any} */
  const sql = (strings, ...values) => {
    const statement = strings.join('?');
    queries.push(statement);
    if (statement.includes('UPDATE users')) {
      const [json, owner, revision] = values;
      const prefs = users.get(owner);
      if (!prefs || String(prefs.savedSearchViews?.revision ?? 0) !== revision) return [];
      users.set(owner, { ...prefs, savedSearchViews: json.value });
      return [{ views: json.value }];
    }
    const prefs = users.get(values[0]);
    return prefs ? [{ views: prefs.savedSearchViews ?? null }] : [];
  };
  sql.json = (value) => ({ value });
  return { sql, users, queries };
}

describe('saved mail-view queries', () => {
  test('accepts supported search words and one value per filter', () => {
    expect(
      savedQueryError('invoice from:"Jane Doe" tag:Work has:attachment before:2026-12-31'),
    ).toBeNull();
    expect(savedQueryError('sender:client@example.com')).toBeNull();
  });

  test.each([
    ['after:2026-02-30', 'real date'],
    ['before:2026-13-01', 'real date'],
    ['from:a sender:b', 'only once'],
    ['from:a from:b', 'only once'],
    ['from:a OR from:b', 'Boolean'],
    ['has:images', 'has:attachment'],
    ['in:unread invoice', 'folder selector'],
    ['is:starred', 'not a supported'],
    ['from:"Unclosed', 'quotation mark'],
  ])('explains unsupported query %s', (query, message) => {
    expect(savedQueryError(query)).toContain(message);
  });
});

describe('saved-view persistence', () => {
  test('stores views by verified owner without replacing unrelated preferences', async () => {
    const { sql, users, queries } = database();
    expect(await (await getSavedViews(sql, A)).json()).toEqual({ revision: 0, views: [] });
    const response = await putSavedViews(sql, A, { revision: 0, views: [view] });
    expect(response.status).toBe(200);
    expect((await response.json()).revision).toBe(1);
    expect((await (await getSavedViews(sql, B)).json()).views).toEqual([]);
    expect((await (await getSavedViews(sql, A)).json()).views).toEqual([view]);
    expect(users.get(A)?.theme).toBe('dark');
    expect(queries.find((query) => query.includes('UPDATE users'))).toContain('jsonb_set');
    expect(queries.find((query) => query.includes('UPDATE users'))).toContain(
      "coalesce(prefs -> 'savedSearchViews' ->> 'revision', '0')",
    );
  });

  test('concurrent saves from one revision return a current-document conflict', async () => {
    const { sql } = database();
    const other = { ...view, id: '22222222-2222-4222-8222-222222222222', name: 'Other' };
    const [first, second] = await Promise.all([
      putSavedViews(sql, A, { revision: 0, views: [view] }),
      putSavedViews(sql, A, { revision: 0, views: [other] }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const conflict = first.status === 409 ? first : second;
    expect((await conflict.json()).current.revision).toBe(1);
    expect(conflict.headers.get('Cache-Control')).toBe('private, no-store');
  });

  test('deleting a definition only updates preferences', async () => {
    const { sql, queries } = database();
    await putSavedViews(sql, A, { revision: 0, views: [view] });
    const deleted = await putSavedViews(sql, A, { revision: 1, views: [] });
    expect((await deleted.json()).views).toEqual([]);
    expect(queries.every((query) => !/\b(?:messages|message_labels)\b/i.test(query))).toBe(true);
  });

  test('rejects duplicate names, unsupported queries, and unbounded lists before SQL', async () => {
    const { sql, queries } = database();
    const duplicate = { ...view, id: '22222222-2222-4222-8222-222222222222', name: 'client MAIL' };
    expect(savedViewsError({ revision: 0, views: [view, duplicate] })).toContain('unique');
    expect(
      savedViewsError({ revision: 0, views: [{ ...view, query: 'after:2026-02-30' }] }),
    ).toContain('real date');
    expect(savedViewsError({ revision: 0, views: Array(31).fill(view) })).toContain('at most 30');
    expect((await putSavedViews(sql, A, { revision: 0, views: [view, duplicate] })).status).toBe(
      400,
    );
    expect(queries).toEqual([]);
  });
});
