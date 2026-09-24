import { describe, expect, test } from 'vitest';
import {
  fetchInterests,
  lookupUserId,
  storeDigest,
  storeEmailAnalysis,
  storeNews,
  storeTasks,
  storeSummary,
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

describe('storeTasks', () => {
  test('upserts all tasks in a single batched statement, keyed by source and external id', async () => {
    const sql = mockSql();
    const stored = await storeTasks(sql, 'user-1', [
      {
        source: 'email',
        externalId: 'msg-9:reply',
        content: 'Reply to accountant',
        dueDate: '2026-07-18',
        messageId: 'msg-9',
        raw: { importance: 'high' },
      },
      { source: 'email', externalId: 'msg-9', content: 'Reply to accountant', messageId: 'msg-9' },
    ]);
    expect(stored).toBe(2);
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain('INSERT INTO tasks');
    expect(sql.calls[0].text).toContain('FROM jsonb_to_recordset');
    expect(sql.calls[0].text).toContain('ON CONFLICT (user_id, source, external_id)');
    expect(sql.calls[0].values).toContain('user-1');
    expect(sql.calls[0].values).toContainEqual({
      __pgJson: [
        {
          source: 'email',
          external_id: 'msg-9:reply',
          content: 'Reply to accountant',
          description: null,
          due_date: '2026-07-18',
          priority: null,
          url: null,
          message_id: 'msg-9',
          raw: { importance: 'high' },
        },
        {
          source: 'email',
          external_id: 'msg-9',
          content: 'Reply to accountant',
          description: null,
          due_date: null,
          priority: null,
          url: null,
          message_id: 'msg-9',
          raw: {},
        },
      ],
    });
  });

  test('writes nothing for an empty gather', async () => {
    const sql = mockSql();
    await expect(storeTasks(sql, 'user-1', [])).resolves.toBe(0);
    expect(sql.calls).toHaveLength(0);
  });
});

describe('storeSummary', () => {
  test('upserts a per-message summary', async () => {
    const sql = mockSql();
    await storeSummary(sql, 'user-1', {
      messageId: 'msg-9',
      summary: 'Accountant needs the VAT receipts by Friday.',
      model: 'gpt-5.6-luna',
      raw: { importance: 'high' },
    });
    expect(sql.calls[0].text).toContain('INSERT INTO summaries');
    expect(sql.calls[0].text).toContain('ON CONFLICT (user_id, message_id, kind)');
    expect(sql.calls[0].values).toEqual(
      expect.arrayContaining(['msg-9', 'email_tasks', 'gpt-5.6-luna']),
    );
    expect(sql.calls[0].values).toContainEqual({ __pgJson: { importance: 'high' } });
  });
});

describe('storeEmailAnalysis', () => {
  test('writes tasks before the completion summary in one transaction', async () => {
    const sql = mockSql();
    await storeEmailAnalysis(sql, 'user-1', { messageId: 'msg-9', summary: 'Reply needed.' }, [
      { source: 'email', externalId: 'msg-9:reply', content: 'Reply', messageId: 'msg-9' },
    ]);

    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[0].text).toContain('INSERT INTO tasks');
    expect(sql.calls[1].text).toContain('INSERT INTO summaries');
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
