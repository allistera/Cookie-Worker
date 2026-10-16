import { describe, expect, it } from 'vitest';
import { getTaskActivity, getTaskProgress, putTaskGoals } from '../src/taskActivity.js';
import { createMockSql } from './helpers.js';
import { encodeCursor } from '../../../shared/pagination.js';
const USER = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const TIME = '2026-10-16T12:00:00.000001Z';

describe('task activity', () => {
  it('scopes history to the caller even after the task is deleted', async () => {
    const row = {
      id: EVENT,
      taskId: TASK,
      title: 'Deleted task',
      action: 'deleted',
      changes: {},
      taskExists: false,
      occurredAt: TIME,
      cursor_time: TIME,
    };
    const sql = createMockSql([[row]]);
    const response = await getTaskActivity(
      sql,
      USER,
      new URL(`https://x/task-activity?task=${TASK}`),
    );
    const result = await response.json();
    expect(result.activities[0]).toMatchObject({ action: 'deleted', taskExists: false });
    expect(result.activities[0].cursor_time).toBeUndefined();
    expect(sql.calls[0].text).toContain('WHERE a.user_id = ?');
    expect(sql.calls[0].text).toContain('LEFT JOIN task_items');
    expect(sql.calls[0].values).toContain(USER);
    expect(sql.calls[0].values).toContain(TASK);
  });
  it('pages completion history without losing microseconds', async () => {
    const sql = createMockSql([
      Array.from({ length: 51 }, () => ({ id: EVENT, cursor_time: TIME })),
    ]);
    const result = await (
      await getTaskActivity(sql, USER, new URL('https://x/task-activity?completed=true'))
    ).json();
    expect(result.activities).toHaveLength(50);
    expect(result.nextCursor).toBe(encodeCursor([TIME, EVENT]));
    const next = createMockSql([[]]);
    await getTaskActivity(
      next,
      USER,
      new URL(`https://x/task-activity?completed=true&after=${result.nextCursor}`),
    );
    expect(next.calls[0].values).toEqual(expect.arrayContaining([TIME, EVENT, USER]));
    expect(next.calls[0].text).toContain("a.action = 'completed'");
  });
  it.each([
    'task=bad',
    'completed=false',
    'after=bad',
    `after=${encodeCursor(['2026-02-31T00:00:00.000000Z', EVENT])}`,
  ])('rejects invalid query %s before SQL', async (query) => {
    const sql = createMockSql([]);
    expect(
      (await getTaskActivity(sql, USER, new URL(`https://x/task-activity?${query}`))).status,
    ).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });
});

describe('progress and goals', () => {
  it('uses local calendar boundaries and defaults goals to disabled', async () => {
    const sql = createMockSql([[{ name: 'Europe/London' }], [{ daily: 2, weekly: 8 }], []]);
    const result = await (
      await getTaskProgress(sql, USER, new URL('https://x/task-progress?timeZone=Europe/London'))
    ).json();
    expect(result).toEqual({
      summary: { daily: 2, weekly: 8 },
      goals: { daily: 0, weekly: 0 },
      timeZone: 'Europe/London',
    });
    expect(sql.calls[1].values).toContain('Europe/London');
    expect(sql.calls[1].values).toContain(USER);
    expect(sql.calls[1].text).toContain("date_trunc('week'");
    expect(sql.calls[1].text).toContain('a.occurred_at <= now()');
  });
  it('rejects unknown zones', async () => {
    const sql = createMockSql([[]]);
    expect(
      (await getTaskProgress(sql, USER, new URL('https://x/task-progress?timeZone=bad'))).status,
    ).toBe(400);
    expect(sql.calls).toHaveLength(1);
  });
  it.each([
    null,
    {},
    { daily: -1, weekly: 5 },
    { daily: 2.5, weekly: 5 },
    { daily: '5', weekly: 10 },
    { daily: 1, weekly: 10001 },
  ])('rejects invalid goals %j', async (body) => {
    const sql = createMockSql([]);
    expect((await putTaskGoals(sql, USER, body)).status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });
  it('persists goals for the authenticated user, ignoring a supplied owner', async () => {
    const sql = createMockSql([[{ daily: 0, weekly: 20 }]]);
    const result = await (
      await putTaskGoals(sql, USER, { daily: 0, weekly: 20, userId: TASK })
    ).json();
    expect(result.goals).toEqual({ daily: 0, weekly: 20 });
    expect(sql.calls[0].values).toEqual([USER, 0, 20]);
  });
});
