import { describe, expect, it } from 'vitest';
import {
  buildDigest,
  buildNews,
  deleteOwnedTask,
  digestMessageIds,
  fetchLatestSummary,
  fetchMessageStates,
  fetchOwnedTask,
  fetchTasks,
  getTasks,
  postTasks,
  updateTaskDueDate,
} from '../src/tasks.js';
import { createMockSql } from './helpers.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';
const USER_ID = '99999999-9999-9999-9999-999999999999';
const TASK_ID = '44444444-4444-4444-8444-444444444444';

function digestRow(
  topics,
  summary = 'One reply needs you and one message is worth reviewing.',
  noise,
) {
  return { summary, raw: { topics, noise }, created_at: '2026-08-03T05:00:00.000Z' };
}

/** @template T @param {T} value @returns {NonNullable<T>} */
function nonNull(value) {
  if (value === null || value === undefined) throw new Error('expected a non-null value');
  return /** @type {NonNullable<T>} */ (value);
}

describe('fetchTasks', () => {
  it('unions gathered email tasks with built-in task_items, most-pressing first', () => {
    const sql = createMockSql();
    fetchTasks(sql, USER_ID, null);

    expect(sql.calls[0].text).toContain('FROM tasks t');
    expect(sql.calls[0].text).toContain(
      'LEFT JOIN messages m ON m.id = t.message_id AND m.user_id = t.user_id',
    );
    expect(sql.calls[0].text).toContain("t.source = 'email'");
    expect(sql.calls[0].text).toContain('m.from_address AS reply_to');
    expect(sql.calls[0].text).toContain('m.subject AS message_subject');
    expect(sql.calls[0].text).toContain('UNION ALL');
    expect(sql.calls[0].text).toContain('FROM task_items t');
    expect(sql.calls[0].text).toContain("'task' AS source");
    expect(sql.calls[0].text).toContain('t.parent_id IS NULL');
    expect(sql.calls[0].text).toContain('t.completed_at IS NULL');
    expect(sql.calls[0].text).toContain(
      'ORDER BY due_date ASC NULLS LAST, priority DESC NULLS LAST, created_at DESC',
    );
  });

  it('scopes the gathered branch to due today or overdue, falling back to CURRENT_DATE', () => {
    const sql = createMockSql();
    fetchTasks(sql, USER_ID, null);
    expect(sql.calls[0].text).toContain('t.due_date IS NULL OR t.due_date <= COALESCE(');
    expect(sql.calls[0].text).toContain('::date, CURRENT_DATE)');
  });

  it('passes a supplied date through to both branches', () => {
    const sql = createMockSql();
    fetchTasks(sql, USER_ID, '2026-08-25');
    expect(sql.calls[0].values).toContain('2026-08-25');
  });

  // Marking the source email Done means the work is handled, so its extracted
  // action item should not keep asking for attention.
  it('drops a gathered task whose source email is done', () => {
    const sql = createMockSql();
    fetchTasks(sql, USER_ID, null);
    expect(sql.calls[0].text).toContain('t.message_id IS NULL OR NOT m.is_archived');
  });

  it('excludes a task_item with no due date, and one already completed', () => {
    const sql = createMockSql();
    fetchTasks(sql, USER_ID, null);
    expect(sql.calls[0].text).toContain('t.due_date <= COALESCE(');
    expect(sql.calls[0].text).toContain('t.completed_at IS NULL');
  });
});

describe('fetchLatestSummary', () => {
  it('reads the newest whole-mailbox row of the given kind', () => {
    const sql = createMockSql();
    fetchLatestSummary(sql, USER_ID, 'daily_digest');

    expect(sql.calls[0].text).toContain('FROM summaries s');
    expect(sql.calls[0].text).toContain('WHERE s.user_id =');
    expect(sql.calls[0].text).toContain('s.message_id IS NULL');
    expect(sql.calls[0].text).toContain('ORDER BY s.created_at DESC');
    expect(sql.calls[0].text).toContain('LIMIT 1');
    expect(sql.calls[0].values).toEqual([USER_ID, 'daily_digest']);
  });
});

describe('fetchMessageStates', () => {
  // is_archived is read rather than filtered in SQL: buildDigest needs to see
  // done messages to drop their items, and the same rows also carry the read
  // state the surviving items render.
  it('reads live read-state and done-state, excluding deleted mail', () => {
    const sql = createMockSql();
    fetchMessageStates(sql, USER_ID, [ID_A]);

    expect(sql.calls[0].text).toContain('m.is_unread');
    expect(sql.calls[0].text).toContain('m.is_archived');
    expect(sql.calls[0].text).toContain('m.scheduled_for');
    expect(sql.calls[0].text).toContain('WHERE m.user_id =');
    expect(sql.calls[0].text).toContain('::uuid[]');
    expect(sql.calls[0].text).toContain('NOT m.is_deleted');
    expect(sql.calls[0].values).toEqual([USER_ID, [ID_A]]);
  });
});

describe('digestMessageIds', () => {
  it('collects the cited ids without duplicates', () => {
    const row = digestRow([
      { items: [{ message_id: ID_A }, { message_id: ID_B }] },
      { items: [{ message_id: ID_A }, { message_id: ID_C }] },
    ]);
    expect(digestMessageIds(row)).toEqual([ID_A, ID_B, ID_C]);
  });

  it('discards anything that is not a uuid', () => {
    const row = digestRow([
      { items: [{ message_id: ID_A }, { message_id: "'); DROP TABLE messages;--" }] },
      { items: [{ message_id: null }, { message_id: 42 }, {}] },
    ]);
    expect(digestMessageIds(row)).toEqual([ID_A]);
  });

  it('returns nothing for a missing or malformed row', () => {
    expect(digestMessageIds(undefined)).toEqual([]);
    expect(digestMessageIds({ raw: null })).toEqual([]);
    expect(digestMessageIds({ raw: { topics: 'nope' } })).toEqual([]);
  });
});

describe('buildDigest', () => {
  it('folds live read-state into the stored digest', () => {
    const row = digestRow([
      {
        emoji: '↩️',
        title: 'Reply Needed',
        items: [
          { message_id: ID_A, headline: 'Floor plan', note: 'Revised design.' },
          { message_id: ID_B, headline: 'Claim', note: 'Processed.' },
        ],
      },
    ]);
    const digest = nonNull(
      buildDigest(row, [
        { id: ID_A, is_unread: true },
        { id: ID_B, is_unread: false },
      ]),
    );

    expect(digest.overview).toBe('One reply needs you and one message is worth reviewing.');
    expect(digest.created_at).toBe('2026-08-03T05:00:00.000Z');
    expect(digest.topics[0].items).toEqual([
      { message_id: ID_A, headline: 'Floor plan', note: 'Revised design.', unread: true },
      { message_id: ID_B, headline: 'Claim', note: 'Processed.', unread: false },
    ]);
  });

  it('drops items whose message left the mailbox, and topics that empties', () => {
    const row = digestRow([
      { emoji: '🍳', title: 'Kitchen', items: [{ message_id: ID_A }, { message_id: ID_B }] },
      { emoji: '📣', title: 'Gone', items: [{ message_id: ID_C }] },
    ]);
    const digest = nonNull(buildDigest(row, [{ id: ID_A, is_unread: true }]));

    expect(digest.topics).toHaveLength(1);
    expect(digest.topics[0].title).toBe('Kitchen');
    expect(digest.topics[0].items.map((/** @type {any} */ i) => i.message_id)).toEqual([ID_A]);
  });

  it('drops items whose message was rescheduled to the future', () => {
    const row = digestRow([
      { emoji: '↩️', title: 'Reply Needed', items: [{ message_id: ID_A }, { message_id: ID_B }] },
    ]);
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const digest = nonNull(
      buildDigest(row, [
        { id: ID_A, is_unread: true, scheduled_for: future },
        { id: ID_B, is_unread: true, scheduled_for: past },
      ]),
    );

    expect(digest.topics).toHaveLength(1);
    expect(digest.topics[0].items.map((/** @type {any} */ i) => i.message_id)).toEqual([ID_B]);
  });

  // Done means handled, whether or not it was ever opened.
  it('drops items whose message is done, read or not', () => {
    const row = digestRow([
      {
        emoji: '↩️',
        title: 'Reply Needed',
        items: [{ message_id: ID_A }, { message_id: ID_B }, { message_id: ID_C }],
      },
    ]);
    const digest = nonNull(
      buildDigest(row, [
        { id: ID_A, is_unread: false, is_archived: true },
        { id: ID_B, is_unread: true, is_archived: true },
        { id: ID_C, is_unread: false, is_archived: false },
      ]),
    );

    // Only the read-but-not-done message survives: being read is not enough
    // to hide an item, and being unread does not rescue a done one.
    expect(digest.topics[0].items.map((/** @type {any} */ i) => i.message_id)).toEqual([ID_C]);
  });

  it('drops a topic left empty because every item was done', () => {
    const row = digestRow([
      { emoji: '↩️', title: 'All handled', items: [{ message_id: ID_A }] },
      { emoji: '👀', title: 'Review', items: [{ message_id: ID_B }] },
    ]);
    const digest = nonNull(
      buildDigest(row, [
        { id: ID_A, is_unread: true, is_archived: true },
        { id: ID_B, is_unread: true, is_archived: false },
      ]),
    );

    expect(digest.topics).toHaveLength(1);
    expect(digest.topics[0].title).toBe('Review');
  });

  it('keeps items whose message has no scheduled_for', () => {
    const row = digestRow([{ emoji: '↩️', title: 'Reply Needed', items: [{ message_id: ID_A }] }]);
    const digest = nonNull(buildDigest(row, [{ id: ID_A, is_unread: true, scheduled_for: null }]));
    expect(digest.topics[0].items.map((/** @type {any} */ i) => i.message_id)).toEqual([ID_A]);
  });

  it('is null when no digest has been written yet', () => {
    expect(buildDigest(undefined, [])).toBeNull();
  });

  it('returns sanitized Noise counts without exposing individual messages', () => {
    const row = digestRow([], undefined, {
      count: 99,
      categories: [
        { category: ' marketing ', count: 2 },
        { category: 'automated', count: 1 },
        { category: '', count: 4 },
        { category: 'bad count', count: -1 },
        { category: 'fractional', count: 1.5 },
      ],
    });

    expect(nonNull(buildDigest(row, [])).noise).toEqual({
      count: 3,
      categories: [
        { category: 'marketing', count: 2 },
        { category: 'automated', count: 1 },
      ],
    });
  });
});

describe('buildNews', () => {
  it('drops items without a usable link and empty sections', () => {
    const row = {
      created_at: '2026-08-04T05:00:00.000Z',
      raw: {
        sections: [
          {
            emoji: '💻',
            title: 'GitHub',
            items: [
              {
                title: 'acme/rocket',
                url: 'https://github.com/acme/rocket',
                description: 'Fast',
                note: 'Rust',
                meta: '★ 10',
              },
              { title: 'Bad', url: 'javascript:alert(1)', description: '', note: '', meta: '' },
            ],
          },
          { emoji: '🚀', title: 'Empty', items: [] },
        ],
      },
    };

    const news = nonNull(buildNews(row));
    expect(news.created_at).toBe('2026-08-04T05:00:00.000Z');
    expect(news.sections).toHaveLength(1);
    expect(news.sections[0].items).toEqual([
      {
        title: 'acme/rocket',
        url: 'https://github.com/acme/rocket',
        description: 'Fast',
        note: 'Rust',
        meta: '★ 10',
      },
    ]);
  });

  it('is null when no news has been written yet', () => {
    expect(buildNews(null)).toBeNull();
  });
});

describe('fetchOwnedTask', () => {
  it('selects a gathered task scoped to the owner', () => {
    const sql = createMockSql();
    fetchOwnedTask(sql, TASK_ID, USER_ID);

    expect(sql.calls[0].text).toContain('FROM tasks t');
    expect(sql.calls[0].values).toEqual([TASK_ID, USER_ID]);
  });
});

describe('deleteOwnedTask', () => {
  it("deletes only the owner's task row", () => {
    const sql = createMockSql();
    deleteOwnedTask(sql, TASK_ID, USER_ID);

    expect(sql.calls[0].text).toContain('DELETE FROM tasks t');
    expect(sql.calls[0].values).toEqual([TASK_ID, USER_ID]);
  });
});

describe('updateTaskDueDate', () => {
  it("moves only the owner's task to the new due date", () => {
    const sql = createMockSql();
    updateTaskDueDate(sql, TASK_ID, USER_ID, '2026-08-25');

    expect(sql.calls[0].text).toContain('UPDATE tasks t SET due_date =');
    expect(sql.calls[0].text).toContain('RETURNING t.id, t.due_date');
    expect(sql.calls[0].values).toEqual(['2026-08-25', TASK_ID, USER_ID]);
  });
});

function tasksUrl(query = '') {
  return new URL(`https://cookie-web-tasks.example/tasks${query}`);
}

describe('getTasks', () => {
  it("returns the caller's gathered tasks with a null digest/news when unwritten", async () => {
    const sql = createMockSql([
      [{ id: TASK_ID, source: 'email', content: 'Reply to Ana' }],
      [],
      [],
    ]);
    const response = await getTasks(sql, USER_ID, tasksUrl());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.tasks).toHaveLength(1);
    expect(body.digest).toBeNull();
    expect(body.news).toBeNull();
    expect(sql.calls).toHaveLength(3);
  });

  it('composes the digest with live read-state alongside the tasks', async () => {
    const sql = createMockSql([
      [],
      [
        {
          summary: 'One reply needs you.',
          created_at: '2026-08-03T05:00:00.000Z',
          raw: {
            topics: [
              {
                emoji: '↩️',
                title: 'Reply Needed',
                items: [{ message_id: ID_A, headline: 'Floor plan', note: 'Revised design.' }],
              },
            ],
            noise: { categories: [{ category: 'marketing', count: 2 }] },
          },
        },
      ],
      [],
      [{ id: ID_A, is_unread: true }],
    ]);
    const response = await getTasks(sql, USER_ID, tasksUrl());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(sql.calls[3].text).toContain('m.is_unread');
    expect(body.digest.topics[0].items[0]).toEqual({
      message_id: ID_A,
      headline: 'Floor plan',
      note: 'Revised design.',
      unread: true,
    });
  });

  it('passes a valid date query param through to fetchTasks', async () => {
    const sql = createMockSql([[], [], []]);
    await getTasks(sql, USER_ID, tasksUrl('?date=2026-08-25'));
    expect(sql.calls[0].values).toContain('2026-08-25');
  });

  it('falls back to null (CURRENT_DATE) for a missing or invalid date, never a 400', async () => {
    const sql = createMockSql([[], [], []]);
    const response = await getTasks(sql, USER_ID, tasksUrl('?date=not-a-date'));

    expect(response.status).toBe(200);
    expect(sql.calls[0].values).not.toContain('not-a-date');
  });
});

describe('postTasks', () => {
  it('completes a gathered task', async () => {
    const sql = createMockSql([[{ id: TASK_ID }], []]);
    const response = await postTasks(sql, USER_ID, { id: TASK_ID, action: 'complete' }, undefined);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('rejects a malformed id before touching the database', async () => {
    const sql = createMockSql();
    const response = await postTasks(
      sql,
      USER_ID,
      { id: 'not-a-uuid', action: 'complete' },
      undefined,
    );
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects an unsupported action', async () => {
    const sql = createMockSql();
    const response = await postTasks(sql, USER_ID, { id: TASK_ID, action: 'delete' }, undefined);
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('reschedules a gathered task', async () => {
    const sql = createMockSql([[{ id: TASK_ID }], [{ id: TASK_ID, due_date: '2026-08-25' }]]);
    const response = await postTasks(
      sql,
      USER_ID,
      { id: TASK_ID, action: 'reschedule', due_date: '2026-08-25' },
      undefined,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      task: { id: TASK_ID, due_date: '2026-08-25' },
    });
  });

  it('rejects a malformed due_date before touching the database', async () => {
    const sql = createMockSql();
    const response = await postTasks(
      sql,
      USER_ID,
      { id: TASK_ID, action: 'reschedule', due_date: 'next tuesday' },
      undefined,
    );
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  // Not found in the gathered `tasks` table falls back to task_items via
  // updateTaskItem, which owns that table's ownership check and Meili sync.
  it('completes a task_items row via the fallback path when the gathered table has no match', async () => {
    const sql = createMockSql([
      [],
      [{ id: TASK_ID, parentId: null }],
      [
        {
          id: TASK_ID,
          projectId: null,
          parentId: null,
          dueDate: null,
          completedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
    ]);
    const response = await postTasks(sql, USER_ID, { id: TASK_ID, action: 'complete' }, undefined);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('reschedules a task_items row via the fallback path when the gathered table has no match', async () => {
    const sql = createMockSql([
      [],
      [{ id: TASK_ID, parentId: null }],
      [{ id: TASK_ID, projectId: null, parentId: null, dueDate: '2026-08-25', completedAt: null }],
    ]);
    const response = await postTasks(
      sql,
      USER_ID,
      { id: TASK_ID, action: 'reschedule', due_date: '2026-08-25' },
      undefined,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      task: { id: TASK_ID, due_date: '2026-08-25' },
    });
  });

  it('404s when neither the gathered table nor task_items owns the id', async () => {
    const sql = createMockSql([[], []]);
    const response = await postTasks(sql, USER_ID, { id: TASK_ID, action: 'complete' }, undefined);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Task not found' });
  });
});
