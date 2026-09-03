import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SPAM_RETENTION_DAYS,
  getSpamRetention,
  normalizeSpamRetentionDays,
  putSpamRetention,
} from '../src/spamRetention.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

/** @param {unknown[]} rows @returns {any} */
function stubSql(rows = []) {
  /** @type {{text: string, values: unknown[]}[]} */
  const calls = [];
  const sql = (/** @type {TemplateStringsArray} */ strings, /** @type {unknown[]} */ ...values) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(rows);
  };
  sql.json = (/** @type {unknown} */ value) => ({ __pgJson: value });
  sql.calls = calls;
  return sql;
}

describe('normalizeSpamRetentionDays', () => {
  test.each([
    [30, 30],
    [1, 1],
    [365, 365],
    [7.9, 7],
  ])('accepts %s as %s whole days', (input, expected) => {
    expect(normalizeSpamRetentionDays(input)).toBe(expected);
  });

  test.each([0, -1, 366, Number.NaN, Number.POSITIVE_INFINITY, '30', null, undefined, {}])(
    'rejects %s',
    (input) => {
      expect(normalizeSpamRetentionDays(input)).toBe(null);
    },
  );
});

describe('getSpamRetention', () => {
  test('returns the stored preference with its bounds', async () => {
    const response = await getSpamRetention(stubSql([{ days: 14 }]), USER_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      spamRetentionDays: 14,
      defaultDays: 30,
      minDays: 1,
      maxDays: 365,
    });
  });

  test.each([[[]], [[{ days: null }]], [[{ days: 'soon' }]], [[{ days: 0 }]]])(
    'falls back to the default for an unset or unusable value (%j)',
    async (rows) => {
      const response = await getSpamRetention(stubSql(rows), USER_ID);
      expect((await response.json()).spamRetentionDays).toBe(DEFAULT_SPAM_RETENTION_DAYS);
    },
  );
});

describe('putSpamRetention', () => {
  test('merges the preference into users.prefs as a jsonb object', async () => {
    const sql = stubSql([{ days: 60 }]);
    const response = await putSpamRetention(sql, USER_ID, { spamRetentionDays: 60 });

    expect(response.status).toBe(200);
    expect((await response.json()).spamRetentionDays).toBe(60);
    expect(sql.calls[0].text).toContain("coalesce(prefs, '{}'::jsonb) || ?");
    expect(sql.calls[0].values).toContainEqual({ __pgJson: { spamRetentionDays: 60 } });
  });

  test.each([{ spamRetentionDays: 0 }, { spamRetentionDays: '30' }, {}, null])(
    'rejects %j without writing',
    async (body) => {
      const sql = stubSql([{ days: 30 }]);
      const response = await putSpamRetention(sql, USER_ID, body);
      expect(response.status).toBe(400);
      expect(sql.calls).toHaveLength(0);
    },
  );

  test('404s when the user row is missing', async () => {
    const response = await putSpamRetention(stubSql([]), USER_ID, { spamRetentionDays: 30 });
    expect(response.status).toBe(404);
  });
});
