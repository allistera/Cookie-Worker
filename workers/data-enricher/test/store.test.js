import { describe, expect, test } from 'vitest';
import { lookupUserId, storeTasks, storeSummary } from '../src/store.js';

function mockSql(rows = []) {
  const calls = [];
  const sql = (strings, ...values) => {
    calls.push({ text: strings.join('$'), values });
    return Promise.resolve(rows);
  };
  sql.calls = calls;
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
    await expect(lookupUserId(mockSql([]), 'owner@example.com'))
      .rejects.toThrow('no users row matches OWNER_EMAIL');
  });
});

describe('storeTasks', () => {
  test('upserts each task keyed by source and external id', async () => {
    const sql = mockSql();
    const stored = await storeTasks(sql, 'user-1', [
      {
        source: 'todoist',
        externalId: '8485093748',
        content: 'File VAT return',
        dueDate: '2026-07-18',
        priority: 4,
        url: 'https://app.todoist.com/task/8485093748',
        raw: { id: '8485093748' },
      },
      { source: 'email', externalId: 'msg-9', content: 'Reply to accountant', messageId: 'msg-9' },
    ]);
    expect(stored).toBe(2);
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[0].text).toContain('INSERT INTO tasks');
    expect(sql.calls[0].text).toContain('ON CONFLICT (user_id, source, external_id)');
    expect(sql.calls[0].values).toEqual(expect.arrayContaining(['todoist', '8485093748', 'File VAT return', 4]));
    expect(sql.calls[1].values).toEqual(expect.arrayContaining(['email', 'msg-9', 'msg-9']));
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
    expect(sql.calls[0].values).toEqual(expect.arrayContaining(['msg-9', 'email_tasks', 'gpt-5.6-luna']));
  });
});
