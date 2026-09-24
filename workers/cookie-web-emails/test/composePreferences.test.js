import { describe, expect, test } from 'vitest';
import {
  getComposePreferences,
  putComposePreferences,
  validateComposePreferences,
} from '../src/composePreferences.js';

const USER_A = 'user-a';
const USER_B = 'user-b';
const snippet = { id: 'snippet-1', name: 'hello-world', html: '<p>Hello</p>' };

function database() {
  /** @type {Map<string, {theme: string, composePreferences?: any}>} */
  const users = new Map([
    [USER_A, { theme: 'dark' }],
    [USER_B, { theme: 'light' }],
  ]);
  /** @type {string[]} */
  const queries = [];
  /** @type {any} */
  const sql = (strings, ...values) => {
    const statement = strings.join('?');
    queries.push(statement);
    if (statement.includes('UPDATE users')) {
      const [json, userId, revision] = values;
      const prefs = users.get(userId);
      if (!prefs || String(prefs.composePreferences?.revision ?? 0) !== revision) return [];
      users.set(userId, { ...prefs, composePreferences: json.value });
      return [{ preferences: json.value }];
    }
    const prefs = users.get(values[0]);
    return prefs ? [{ preferences: prefs.composePreferences ?? null }] : [];
  };
  sql.json = (value) => ({ value });
  return { sql, users, queries };
}

describe('composer preferences', () => {
  test('GET defaults to revision zero and isolates two users', async () => {
    const { sql } = database();
    expect(await (await getComposePreferences(sql, USER_A)).json()).toEqual({
      revision: 0,
      signatureHtml: '',
      snippets: [],
    });
    await putComposePreferences(sql, USER_A, {
      revision: 0,
      signatureHtml: '<p>A</p>',
      snippets: [snippet],
    });
    expect((await (await getComposePreferences(sql, USER_B)).json()).signatureHtml).toBe('');
    expect((await (await getComposePreferences(sql, USER_A)).json()).signatureHtml).toBe(
      '<p>A</p>',
    );
  });

  test('concurrent writes from one revision produce a conflict and preserve unrelated prefs', async () => {
    const { sql, users, queries } = database();
    const [first, second] = await Promise.all([
      putComposePreferences(sql, USER_A, {
        revision: 0,
        signatureHtml: '<p>First</p>',
        snippets: [],
      }),
      putComposePreferences(sql, USER_A, {
        revision: 0,
        signatureHtml: '<p>Second</p>',
        snippets: [],
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(users.get(USER_A)?.theme).toBe('dark');
    expect(users.get(USER_A)?.composePreferences?.revision).toBe(1);
    expect(queries.find((query) => query.includes('UPDATE users'))).toContain(
      "coalesce(prefs -> 'composePreferences' ->> 'revision', '0')",
    );
    expect(queries.find((query) => query.includes('UPDATE users'))).toContain('jsonb_set');
    const conflict = first.status === 409 ? first : second;
    expect((await conflict.json()).current).toEqual(users.get(USER_A)?.composePreferences);
  });

  test('rejects duplicate triggers and malformed data without writing', async () => {
    const { sql, users } = database();
    const invalid = {
      revision: 0,
      signatureHtml: '',
      snippets: [snippet, { ...snippet, id: 'other' }],
    };
    expect(validateComposePreferences(invalid)).toBe(false);
    expect((await putComposePreferences(sql, USER_A, invalid)).status).toBe(400);
    expect(users.get(USER_A)).toEqual({ theme: 'dark' });
  });

  test('rejects a missing user', async () => {
    const { sql } = database();
    expect((await getComposePreferences(sql, 'missing')).status).toBe(404);
    expect(
      (
        await putComposePreferences(sql, 'missing', {
          revision: 0,
          signatureHtml: '',
          snippets: [],
        })
      ).status,
    ).toBe(404);
  });
});
