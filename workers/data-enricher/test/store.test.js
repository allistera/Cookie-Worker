import { describe, expect, test } from 'vitest';
import {
  fetchInterests,
  hasNewsForUkToday,
  lookupUserId,
  storeDigest,
  storeNews,
} from '../src/store.js';

function mockSql(rows = []) {
  const calls = [];
  const sql = (strings, ...values) => {
    calls.push({ text: strings.join('$'), values });
    return Promise.resolve(rows);
  };
  sql.calls = calls;
  // Mirrors postgres.js's sql.json: marks a value to be sent as a real jsonb
  // parameter instead of pre-stringifying it into a jsonb string scalar.
  sql.json = (value) => ({ __pgJson: value });
  sql.begin = async (callback) => callback(sql);
  return /** @type {import('postgres').Sql & {calls: {text: string, values: unknown[]}[]}} */ (
    /** @type {unknown} */ (sql)
  );
}

describe('lookupUserId', () => {
  test('resolves the owner user id', async () => {
    const sql = mockSql([{ id: 'user-1' }]);
    await expect(lookupUserId(sql, 'owner@example.com')).resolves.toBe('user-1');
    expect(sql.calls[0].text).toContain('FROM users');
    expect(sql.calls[0].values).toContain('owner@example.com');
  });

  test('throws when no user matches', async () => {
    await expect(lookupUserId(mockSql([]), 'owner@example.com')).rejects.toThrow(
      'no users row matches OWNER_EMAIL',
    );
  });
});

describe('storeDigest', () => {
  const digest = {
    overview: 'One reply and two lower-priority messages.',
    topics: [{ emoji: '↩️', title: 'Reply Needed', items: [] }],
    noise: { count: 2, categories: [{ category: 'marketing', count: 2 }] },
  };

  test('inserts the new digest before pruning superseded ones', async () => {
    const sql = mockSql([{ id: 'digest-2' }]);
    await expect(storeDigest(sql, 'user-1', digest, 'gpt-5.6-luna')).resolves.toBe('digest-2');

    // Insert first: a failure here must leave yesterday's digest readable.
    expect(sql.calls[0].text).toContain('pg_advisory_xact_lock');
    expect(sql.calls[1].text).toContain('INSERT INTO summaries');
    expect(sql.calls[1].values).toEqual(
      expect.arrayContaining([
        'user-1',
        'daily_digest',
        'One reply and two lower-priority messages.',
        'gpt-5.6-luna',
      ]),
    );
    expect(sql.calls[1].values).toContainEqual({
      __pgJson: {
        topics: digest.topics,
        noise: digest.noise,
        prompt_version: 'email-triage-v1',
        policy_source: 'ericporres/email-triage-plugin',
      },
    });

    expect(sql.calls[2].text).toContain('DELETE FROM summaries');
    expect(sql.calls[2].text).toContain('message_id IS NULL');
    expect(sql.calls[2].values).toEqual(
      expect.arrayContaining(['user-1', 'daily_digest', 'digest-2']),
    );
  });

  test('stores empty triage so a quiet day clears stale results', async () => {
    const sql = mockSql([{ id: 'digest-3' }]);
    await storeDigest(sql, 'user-1', { overview: '', topics: [] }, null);
    expect(sql.calls[1].values).toContain('');
    expect(sql.calls).toHaveLength(3);
  });

  test('records all source ids, including noise, so later blocking can hide the whole generated snapshot', async () => {
    const sql = mockSql([{ id: 'digest-4' }]);
    await storeDigest(sql, 'user-1', digest, null, ['visible-mail', 'noise-mail']);
    expect(sql.calls[1].values).toContainEqual({
      __pgJson: expect.objectContaining({ source_message_ids: ['visible-mail', 'noise-mail'] }),
    });
  });
});

describe('fetchInterests', () => {
  test('reads the interests key out of prefs', async () => {
    const sql = mockSql([{ interests: ['Rust', 'Postgres'] }]);
    await expect(fetchInterests(sql, 'user-1')).resolves.toEqual(['Rust', 'Postgres']);
    expect(sql.calls[0].text).toContain("prefs -> 'interests'");
    expect(sql.calls[0].values).toContain('user-1');
  });

  // Absent or malformed prefs mean "do not personalise", never a crash.
  test('falls back to an empty list', async () => {
    await expect(fetchInterests(mockSql([]), 'user-1')).resolves.toEqual([]);
    await expect(fetchInterests(mockSql([{ interests: null }]), 'user-1')).resolves.toEqual([]);
    await expect(fetchInterests(mockSql([{ interests: 'Rust' }]), 'user-1')).resolves.toEqual([]);
  });

  test('drops non-string entries', async () => {
    const sql = mockSql([{ interests: ['Rust', 42, null] }]);
    await expect(fetchInterests(sql, 'user-1')).resolves.toEqual(['Rust']);
  });
});

describe('storeNews', () => {
  test('inserts the new news before pruning superseded ones', async () => {
    const sql = mockSql([{ id: 'news-2' }]);
    const news = { sections: [{ emoji: '💻', title: 'GitHub', items: [] }] };

    await expect(storeNews(sql, 'user-1', news, 'gpt-5.6-luna')).resolves.toBe('news-2');

    expect(sql.calls[0].text).toContain('pg_advisory_xact_lock');
    expect(sql.calls[1].text).toContain('INSERT INTO summaries');
    expect(sql.calls[1].values).toEqual(expect.arrayContaining(['user-1', 'daily_news']));
    expect(sql.calls[1].values).toContainEqual({
      __pgJson: { sections: news.sections, prompt_version: 'daily-news-v1' },
    });
    expect(sql.calls[2].text).toContain('DELETE FROM summaries');
    expect(sql.calls[2].values).toEqual(expect.arrayContaining(['user-1', 'daily_news', 'news-2']));
  });
});

describe('hasNewsForUkToday', () => {
  test("checks for a non-empty round-up stored on today's UK date", async () => {
    const sql = mockSql([{ fresh: true }]);
    await expect(hasNewsForUkToday(sql, 'user-1')).resolves.toBe(true);
    expect(sql.calls[0].text).toContain("AT TIME ZONE 'Europe/London'");
    expect(sql.calls[0].text).toContain("jsonb_array_length(raw -> 'sections') > 0");
    expect(sql.calls[0].values).toEqual(expect.arrayContaining(['user-1', 'daily_news']));
  });

  test('is false when nothing matches', async () => {
    await expect(hasNewsForUkToday(mockSql([{ fresh: false }]), 'user-1')).resolves.toBe(false);
  });
});
