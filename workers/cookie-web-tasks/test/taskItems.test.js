import { describe, expect, it, vi } from 'vitest';
import {
  createTaskItem,
  deleteTaskItem,
  getTaskItems,
  reorderTaskItems,
  updateTaskItem,
} from '../src/taskItems.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-9999-9999-999999999999';
const ITEM_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

const url = (query) => new URL(`https://example.test/task-items${query}`);

describe('GET /task-items', () => {
  it('lists a project, oldest first, hiding completed tasks', async () => {
    const sql = createMockSql([[{ id: ITEM_ID, projectId: PROJECT_ID, content: 'Ship it' }]]);

    const response = await getTaskItems(sql, USER_ID, url(`?project=${PROJECT_ID}`));

    expect(response.status).toBe(200);
    expect((await response.json()).items).toHaveLength(1);
    expect(sql.calls[0].text).toContain('FROM task_items t');
    // Arranged order first (drag and drop), creation order as the tiebreak.
    expect(sql.calls[0].text).toContain('t.position ASC, t.created_at ASC');
    expect(sql.calls[0].text).toContain('t.position, t.today_position AS "todayPosition"');
    expect(sql.calls[0].values).toEqual([
      USER_ID,
      false,
      null,
      USER_ID,
      null,
      false,
      PROJECT_ID,
      false,
      false,
      false,
    ]);
  });

  // Inbox is a rule, not a row: it means "belongs to no project".
  it('treats project=inbox as project_id IS NULL', async () => {
    const sql = createMockSql([[]]);
    await getTaskItems(sql, USER_ID, url('?project=inbox'));

    expect(sql.calls[0].values).toEqual([
      USER_ID,
      false,
      null,
      USER_ID,
      null,
      true,
      null,
      false,
      false,
      false,
    ]);
    expect(sql.calls[0].values).not.toContain('inbox');
  });

  it('includes completed tasks when asked', async () => {
    const sql = createMockSql([[]]);
    await getTaskItems(sql, USER_ID, url('?project=inbox&completed=1'));

    expect(sql.calls[0].values).toEqual([
      USER_ID,
      false,
      null,
      USER_ID,
      null,
      true,
      null,
      true,
      false,
      false,
    ]);
  });

  it('400s a project that is neither a uuid nor inbox', async () => {
    const sql = createMockSql([]);
    const response = await getTaskItems(sql, USER_ID, url('?project=nonsense'));
    expect(response.status).toBe(400);
  });
});

describe('POST /task-items', () => {
  it('creates a task in a project', async () => {
    const sql = createMockSql([
      [{ id: PROJECT_ID }],
      [{ id: ITEM_ID, projectId: PROJECT_ID, content: 'Ship it' }],
    ]);

    const response = await createTaskItem(sql, USER_ID, {
      content: 'Ship it',
      projectId: PROJECT_ID,
    });

    expect(response.status).toBe(201);
    expect((await response.json()).item.content).toBe('Ship it');
  });

  it('creates an Inbox task when no project is given', async () => {
    const sql = createMockSql([[{ id: ITEM_ID, projectId: null, content: 'Ship it' }]]);

    const response = await createTaskItem(sql, USER_ID, { content: 'Ship it' });

    expect(response.status).toBe(201);
    expect((await response.json()).item.projectId).toBeNull();
  });

  it('stores a local due time, its time zone, and normalized labels', async () => {
    const sql = createMockSql([
      [], // label registration
      [
        {
          id: ITEM_ID,
          content: 'Call plumber',
          dueDate: '2026-09-11',
          dueTime: '15:00',
          timeZone: 'Europe/London',
          labels: ['home'],
        },
      ],
    ]);

    const response = await createTaskItem(sql, USER_ID, {
      content: 'Call plumber',
      dueDate: '2026-09-11',
      dueTime: '15:00',
      timeZone: 'Europe/London',
      labels: ['@Home', 'home'],
    });

    expect(response.status).toBe(201);
    const register = sql.calls.find((call) => call.text.includes('INSERT INTO task_labels'));
    expect(register.text).toContain('ON CONFLICT (user_id, name) DO NOTHING');
    expect(register.values).toEqual(expect.arrayContaining([USER_ID, ['home']]));
    const insert = sql.calls.find((call) => call.text.includes('INSERT INTO task_items'));
    expect(insert.text).toContain('due_time, time_zone, labels');
    expect(insert.values).toEqual(expect.arrayContaining(['15:00', 'Europe/London', ['home']]));
  });

  it('registers no labels when a task is created without any', async () => {
    const sql = createMockSql([[{ id: ITEM_ID, projectId: null, content: 'Ship it' }]]);

    await createTaskItem(sql, USER_ID, { content: 'Ship it' });

    expect(sql.calls.some((call) => call.text.includes('INSERT INTO task_labels'))).toBe(false);
  });

  it('rejects a due time without a date', async () => {
    const response = await createTaskItem(createMockSql([]), USER_ID, {
      content: 'Call plumber',
      dueTime: '15:00',
      timeZone: 'Europe/London',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('requires a due date'),
    });
  });

  it('rejects a blank content', async () => {
    const sql = createMockSql([]);
    const response = await createTaskItem(sql, USER_ID, { content: '   ' });
    expect(response.status).toBe(400);
  });

  it('404s a project the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await createTaskItem(sql, USER_ID, {
      content: 'Ship it',
      projectId: PROJECT_ID,
    });
    expect(response.status).toBe(404);
  });

  // A sub-task always lands in its parent's project — the body's projectId
  // is ignored so the two can never disagree.
  it("creates a sub-task in its parent's project, ignoring any projectId", async () => {
    const sql = createMockSql([
      [{ id: ITEM_ID, projectId: PROJECT_ID }],
      [
        {
          id: '33333333-3333-4333-8333-333333333333',
          projectId: PROJECT_ID,
          parentId: ITEM_ID,
          content: 'Step one',
        },
      ],
    ]);

    const response = await createTaskItem(sql, USER_ID, {
      content: 'Step one',
      parentId: ITEM_ID,
      projectId: '44444444-4444-4444-8444-444444444444',
    });

    expect(response.status).toBe(201);
    expect((await response.json()).item.parentId).toBe(ITEM_ID);
    // Call 1 looks up the parent; the INSERT carries the parent's project.
    expect(sql.calls[1].values).toContain(PROJECT_ID);
    expect(sql.calls[1].values).toContain(ITEM_ID);
  });

  it('404s a parentId the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await createTaskItem(sql, USER_ID, {
      content: 'Step one',
      parentId: ITEM_ID,
    });
    expect(response.status).toBe(404);
  });

  it('404s a parentId that is not a uuid without touching the database', async () => {
    const sql = createMockSql([]);
    const response = await createTaskItem(sql, USER_ID, {
      content: 'Step one',
      parentId: 'nonsense',
    });
    expect(response.status).toBe(404);
    expect(sql.calls).toHaveLength(0);
  });
});

describe('PATCH /task-items', () => {
  it('renames a task', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, content: 'Renamed' }]]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, content: 'Renamed' });

    expect(response.status).toBe(200);
    expect((await response.json()).item.content).toBe('Renamed');
  });

  // Completion stamps a time rather than deleting, so history survives and
  // un-completing is clearing the column.
  it('stamps completed_at when completed is true and clears it when false', async () => {
    const done = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, completedAt: 't1' }]]);
    await updateTaskItem(done, USER_ID, { id: ITEM_ID, completed: true });
    const doneUpdate = done.calls.find((call) => call.text.includes('UPDATE task_items'));
    expect(doneUpdate.text).toContain('completed_at');
    expect(doneUpdate.text).not.toContain('DELETE');

    const undone = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, completedAt: null }]]);
    const response = await updateTaskItem(undone, USER_ID, { id: ITEM_ID, completed: false });
    expect((await response.json()).item.completedAt).toBeNull();
  });

  it('404s an id the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, content: 'Stolen' });
    expect(response.status).toBe(404);
  });

  it('rejects a move that would make a task its own descendant', async () => {
    const sql = createMockSql([
      [{ id: ITEM_ID }], // the task exists
      [{ id: '33333333-3333-4333-8333-333333333333' }], // the proposed parent exists
      [{ ok: 1 }], // ancestry walk finds the task above the parent
    ]);

    const response = await updateTaskItem(sql, USER_ID, {
      id: ITEM_ID,
      parentId: '33333333-3333-4333-8333-333333333333',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('own descendant');
    expect(sql.calls.some((call) => call.text.includes('UPDATE task_items'))).toBe(false);
  });

  it('moves a task to the Inbox with projectId null', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, projectId: null }]]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, projectId: null });

    expect(response.status).toBe(200);
    expect((await response.json()).item.projectId).toBeNull();
  });

  it('updates due time and labels together', async () => {
    const existing = {
      id: ITEM_ID,
      projectId: null,
      parentId: null,
      kind: 'task',
      dueDate: '2026-09-11',
      dueTime: null,
      timeZone: null,
      labels: [],
      recurrence: null,
      completedAt: null,
    };
    const sql = createMockSql([
      [existing],
      [], // label registration
      [[{ ...existing, dueTime: '15:00', timeZone: 'Europe/London', labels: ['home'] }]].flat(),
    ]);

    const response = await updateTaskItem(sql, USER_ID, {
      id: ITEM_ID,
      dueTime: '15:00',
      timeZone: 'Europe/London',
      labels: ['Home'],
    });

    expect(response.status).toBe(200);
    const register = sql.calls.find((call) => call.text.includes('INSERT INTO task_labels'));
    expect(register.values).toEqual(expect.arrayContaining([USER_ID, ['home']]));
    const update = sql.calls.find((call) => call.text.includes('UPDATE task_items t SET'));
    expect(update.text).toContain('due_time');
    expect(update.text).toContain('labels');
    expect(update.values).toEqual(expect.arrayContaining(['15:00', 'Europe/London', ['home']]));
  });

  it('does not register labels on an update that leaves them alone', async () => {
    const existing = {
      id: ITEM_ID,
      projectId: null,
      parentId: null,
      kind: 'task',
      dueDate: null,
      dueTime: null,
      timeZone: null,
      labels: ['home'],
      recurrence: null,
      completedAt: null,
    };
    const sql = createMockSql([[existing], [{ ...existing, content: 'Renamed' }]]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, content: 'Renamed' });

    expect(response.status).toBe(200);
    expect(sql.calls.some((call) => call.text.includes('INSERT INTO task_labels'))).toBe(false);
  });

  it('clears due time and zone when the due date is removed', async () => {
    const existing = {
      id: ITEM_ID,
      projectId: null,
      parentId: null,
      kind: 'task',
      dueDate: '2026-09-11',
      dueTime: '15:00',
      timeZone: 'Europe/London',
      labels: [],
      recurrence: null,
      completedAt: null,
    };
    const sql = createMockSql([
      [existing],
      [{ ...existing, dueDate: null, dueTime: null, timeZone: null }],
    ]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, dueDate: null });

    expect(response.status).toBe(200);
    const update = sql.calls.find((call) => call.text.includes('UPDATE task_items t SET'));
    expect(update.values).toContain(null);
  });
});

describe('DELETE /task-items', () => {
  it('deletes an owned task', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }]]);
    const response = await deleteTaskItem(sql, USER_ID, { id: ITEM_ID });

    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(sql.calls[0].text).toContain('DELETE FROM task_items');
  });

  it('404s an id the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await deleteTaskItem(sql, USER_ID, { id: ITEM_ID });
    expect(response.status).toBe(404);
  });
});

// A malformed date used to collapse to null and be written, wiping whatever
// date the task already had. Phase 2 puts a date control on this field.
// A Today rank (today_position) is scoped to the day it was arranged on;
// changing the due date must drop it, or the task would carry an old rank
// into the new day and displace rows arranged there.
describe('changing the due date clears the Today rank', () => {
  it('nulls today_position in the same UPDATE as the date', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, dueDate: '2026-09-05' }]]);

    await updateTaskItem(sql, USER_ID, { id: ITEM_ID, dueDate: '2026-09-05' });

    const update = sql.calls.find((call) => call.text.includes('UPDATE task_items'));
    expect(update.text).toContain(
      'today_position = CASE WHEN ?::boolean THEN NULL ELSE t.today_position END',
    );
  });

  it('leaves today_position alone for other edits', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, content: 'Renamed' }]]);

    await updateTaskItem(sql, USER_ID, { id: ITEM_ID, content: 'Renamed' });

    const update = sql.calls.find((call) => call.text.includes('UPDATE task_items'));
    // The hasDueDate flag drives both the date and the rank reset.
    const flagIndex = update.text
      .split('?')
      .findIndex((part) => part.includes('due_date     = CASE WHEN '));
    expect(update.values[flagIndex]).toBe(false);
  });
});

describe('dueDate validation', () => {
  it('rejects a malformed dueDate instead of clearing the date', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }]]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, dueDate: 'tomorrow' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'dueDate must be a YYYY-MM-DD date',
    });
    // The refusal must come before the UPDATE, not after it.
    expect(sql.calls).toHaveLength(1);
  });

  // DATE_RE alone admits this; Postgres then throws at the ::date cast.
  it('rejects a date that does not exist in the calendar', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }]]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, dueDate: '2026-02-31' });

    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(1);
  });

  it('accepts an explicit null dueDate as clearing the date', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, dueDate: null }]]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, dueDate: null });

    expect(response.status).toBe(200);
    expect(sql.calls[1].values).toContain(null);
  });

  it('accepts a well-formed dueDate', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, dueDate: '2026-09-01' }]]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, dueDate: '2026-09-01' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ item: { dueDate: '2026-09-01' } });
    expect(sql.calls[1].values).toContain('2026-09-01');
  });

  it('rejects a malformed dueDate on create', async () => {
    const sql = createMockSql([]);

    const response = await createTaskItem(sql, USER_ID, {
      content: 'Ship it',
      dueDate: '01/09/2026',
    });

    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('still creates a task with no dueDate at all', async () => {
    const sql = createMockSql([[{ id: ITEM_ID, content: 'Ship it', dueDate: null }]]);

    const response = await createTaskItem(sql, USER_ID, { content: 'Ship it' });

    expect(response.status).toBe(201);
  });
});

// postgres.js parses OID 1082 (date) with `new Date(x)`, so an unqualified
// due_date leaves the Worker as "2026-09-01T00:00:00.000Z" once JSON has had
// it — which <input type="date"> refuses, showing an empty dd/mm/yyyy. The
// mock sql cannot reproduce the driver's parsing, so the guard is on the
// query text: the column has to be rendered to text in SQL.
describe('dueDate is returned as a YYYY-MM-DD string, not a timestamp', () => {
  it('renders due_date to text when listing', async () => {
    const sql = createMockSql([[]]);

    await getTaskItems(sql, USER_ID, url('?project=inbox'));

    expect(sql.calls[0].text).toContain(`to_char(t.due_date, 'YYYY-MM-DD') AS "dueDate"`);
    expect(sql.calls[0].text).not.toContain('t.due_date AS "dueDate"');
  });

  it('renders due_date to text when creating', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }]]);

    await createTaskItem(sql, USER_ID, { content: 'Ship it' });

    expect(sql.calls[0].text).toContain(`to_char(due_date, 'YYYY-MM-DD') AS "dueDate"`);
  });

  it('renders due_date to text when updating', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID }]]);

    await updateTaskItem(sql, USER_ID, { id: ITEM_ID, content: 'Renamed' });

    expect(sql.calls[1].text).toContain(`to_char(t.due_date, 'YYYY-MM-DD') AS "dueDate"`);
  });
});

// Today spans every project, so it is a third branch of the same flat query
// rather than a project filter. The date is supplied by the caller: the
// Worker has no idea what "today" is where the person is standing, and
// guessing UTC would show the wrong day for most of the world.
describe('GET /task-items?project=today', () => {
  it('matches tasks due on or before the given date across every project', async () => {
    const sql = createMockSql([[]]);

    const response = await getTaskItems(sql, USER_ID, url('?project=today&date=2026-08-29'));

    expect(response.status).toBe(200);
    expect(sql.calls[0].values).toEqual([
      USER_ID,
      true,
      '2026-08-29',
      USER_ID,
      '2026-08-29',
      false,
      null,
      false,
      true,
      true,
    ]);
    // Overdue tasks belong in Today: a task due last week and still not done
    // would otherwise be visible only inside its own project.
    expect(sql.calls[0].text).toContain('t.due_date <= ');
    expect(sql.calls[0].text).not.toMatch(/t\.due_date = /);
  });

  // With overdue tasks mixed in, created_at ordering would scatter them
  // through the list; the oldest thing owed belongs at the top.
  it('orders by due date first, then by age', async () => {
    const sql = createMockSql([[]]);

    await getTaskItems(sql, USER_ID, url('?project=today&date=2026-08-29'));

    const orderBy = sql.calls[0].text.slice(sql.calls[0].text.indexOf('ORDER BY'));
    expect(orderBy).toContain('t.due_date');
    expect(orderBy.indexOf('t.due_date')).toBeLessThan(orderBy.indexOf('t.created_at'));
  });

  it('requires a date', async () => {
    const sql = createMockSql([]);

    const response = await getTaskItems(sql, USER_ID, url('?project=today'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'today requires a date=YYYY-MM-DD',
    });
    expect(sql.calls).toHaveLength(0);
  });

  it('rejects a malformed date', async () => {
    const sql = createMockSql([]);

    const response = await getTaskItems(sql, USER_ID, url('?project=today&date=29-08-2026'));

    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('rejects a date that does not exist in the calendar', async () => {
    const sql = createMockSql([]);

    const response = await getTaskItems(sql, USER_ID, url('?project=today&date=2026-02-31'));

    expect(response.status).toBe(400);
  });

  it('still hides completed tasks unless asked for them', async () => {
    const sql = createMockSql([[]]);

    await getTaskItems(sql, USER_ID, url('?project=today&date=2026-08-29&completed=1'));

    expect(sql.calls[0].values).toEqual([
      USER_ID,
      true,
      '2026-08-29',
      USER_ID,
      '2026-08-29',
      false,
      null,
      true,
      true,
      true,
    ]);
  });

  it('does not treat today as a project id', async () => {
    const sql = createMockSql([[]]);

    await getTaskItems(sql, USER_ID, url('?project=today&date=2026-08-29'));

    expect(sql.calls[0].values).not.toContain('today');
  });
});

// Todoist-style: 1 is the most urgent, 4 is the default and reads as "no
// priority". Like dueDate, a bad value is refused rather than coerced — a
// silently clamped or nulled priority would overwrite what the task had.
describe('priority', () => {
  it('defaults a new task to priority 4', async () => {
    const sql = createMockSql([[{ id: ITEM_ID, content: 'Ship it', priority: 4 }]]);

    const response = await createTaskItem(sql, USER_ID, { content: 'Ship it' });

    expect(response.status).toBe(201);
    expect(sql.calls[0].text).toContain('priority');
    expect(sql.calls[0].values).toContain(4);
  });

  it('creates a task with the given priority', async () => {
    const sql = createMockSql([[{ id: ITEM_ID, content: 'Ship it', priority: 1 }]]);

    const response = await createTaskItem(sql, USER_ID, { content: 'Ship it', priority: 1 });

    expect(response.status).toBe(201);
    expect(sql.calls[0].values).toContain(1);
    await expect(response.json()).resolves.toMatchObject({ item: { priority: 1 } });
  });

  it.each([0, 5, 2.5, '2', 'high', true])('rejects %j on create', async (priority) => {
    const sql = createMockSql([]);

    const response = await createTaskItem(sql, USER_ID, { content: 'Ship it', priority });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'priority must be an integer from 1 to 4',
    });
    expect(sql.calls).toHaveLength(0);
  });

  it('sets a priority', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, priority: 2 }]]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, priority: 2 });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ item: { priority: 2 } });
    const update = sql.calls[1];
    expect(update.text).toContain('priority     = CASE WHEN');
    expect(update.values).toContain(2);
  });

  it('resets to the default when priority is null', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, priority: 4 }]]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, priority: null });

    expect(response.status).toBe(200);
    expect(sql.calls[1].values).toContain(4);
  });

  it.each([0, 5, 2.5, '2', 'high', true])(
    'rejects %j on update before touching the row',
    async (priority) => {
      const sql = createMockSql([[{ id: ITEM_ID }]]);

      const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, priority });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'priority must be an integer from 1 to 4',
      });
      // Only the ownership lookup ran; no UPDATE.
      expect(sql.calls).toHaveLength(1);
    },
  );

  it('counts priority alone as a change', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, priority: 3 }]]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, priority: 3 });

    expect(response.status).toBe(200);
  });

  it('leaves priority alone when the body does not mention it', async () => {
    const sql = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID, content: 'Renamed' }]]);

    await updateTaskItem(sql, USER_ID, { id: ITEM_ID, content: 'Renamed' });

    // The CASE guard is false, so the column keeps t.priority.
    const update = sql.calls[1];
    const guardIndex = update.text
      .split('?')
      .findIndex((part) => part.includes('priority     = CASE WHEN'));
    expect(update.values[guardIndex]).toBe(false);
  });

  it('returns priority on every read path', async () => {
    const list = createMockSql([[]]);
    await getTaskItems(list, USER_ID, url('?project=inbox'));
    expect(list.calls[0].text).toContain('t.priority');

    const create = createMockSql([[{ id: ITEM_ID }]]);
    await createTaskItem(create, USER_ID, { content: 'Ship it' });
    expect(create.calls[0].text).toMatch(/RETURNING[\s\S]*priority/);

    const update = createMockSql([[{ id: ITEM_ID }], [{ id: ITEM_ID }]]);
    await updateTaskItem(update, USER_ID, { id: ITEM_ID, content: 'Renamed' });
    expect(update.calls[1].text).toMatch(/RETURNING[\s\S]*t\.priority/);
  });
});

// Drag-and-drop ordering: Cookie-Web sends the rows in their new order and
// the position values those rows already hold are dealt back out to match.
describe('POST /task-items/reorder', () => {
  const OTHER_ID = '33333333-3333-4333-8333-333333333333';

  it('deals the given rows\u2019 own positions out in the new order', async () => {
    const sql = createMockSql([
      [
        { id: ITEM_ID, position: 10 },
        { id: OTHER_ID, position: 20 },
      ],
      [
        { id: OTHER_ID, position: 10 },
        { id: ITEM_ID, position: 20 },
      ],
    ]);

    const response = await reorderTaskItems(sql, USER_ID, { ids: [OTHER_ID, ITEM_ID] });

    expect(response.status).toBe(200);
    expect((await response.json()).items).toEqual([
      { id: OTHER_ID, position: 10 },
      { id: ITEM_ID, position: 20 },
    ]);
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[0].text).toContain('WHERE user_id = ? AND id = ANY(?::uuid[])');
    const update = sql.calls[1];
    expect(update.text).toContain('FROM unnest(?::uuid[], ?::float8[]) AS placed(id, position)');
    expect(update.text).toContain('WHERE t.id = placed.id AND t.user_id = ?');
    // The requested order, carrying the sorted existing values.
    expect(update.values).toEqual([[OTHER_ID, ITEM_ID], [10, 20], USER_ID]);
  });

  // Yesterday's renumbering left each list at 1..n, so rows from different
  // projects can share a value; Today must still be able to swap them.
  it('pushes tied positions apart so every row gets its own', async () => {
    const sql = createMockSql([
      [
        { id: ITEM_ID, position: 3 },
        { id: OTHER_ID, position: 3 },
      ],
      [],
    ]);

    await reorderTaskItems(sql, USER_ID, { ids: [OTHER_ID, ITEM_ID] });

    expect(sql.calls[1].values).toEqual([[OTHER_ID, ITEM_ID], [3, 3.001], USER_ID]);
  });

  // Today has an order of its own: a day re-arranged there is numbered in
  // today_position, and `position` — the projects' order — is untouched.
  it('numbers today_position for view: today and leaves position alone', async () => {
    const sql = createMockSql([
      [
        { id: OTHER_ID, todayPosition: 1 },
        { id: ITEM_ID, todayPosition: 2 },
      ],
    ]);

    const response = await reorderTaskItems(sql, USER_ID, {
      ids: [OTHER_ID, ITEM_ID],
      view: 'today',
    });

    expect(response.status).toBe(200);
    expect((await response.json()).items).toEqual([
      { id: OTHER_ID, todayPosition: 1 },
      { id: ITEM_ID, todayPosition: 2 },
    ]);
    expect(sql.calls).toHaveLength(1);
    const { text, values } = sql.calls[0];
    expect(text).toContain('SET today_position = ord.n');
    expect(text).not.toContain('SET position');
    expect(values).toEqual([[OTHER_ID, ITEM_ID], USER_ID]);
  });

  it('refuses a view other than today', async () => {
    const sql = createMockSql([]);
    const response = await reorderTaskItems(sql, USER_ID, { ids: [ITEM_ID], view: 'inbox' });
    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('leaves out ids the caller does not own and writes nothing when none remain', async () => {
    const sql = createMockSql([[]]);
    const response = await reorderTaskItems(sql, USER_ID, { ids: [OTHER_ID] });
    expect(response.status).toBe(200);
    expect((await response.json()).items).toEqual([]);
    expect(sql.calls).toHaveLength(1);
  });

  it.each([
    [{}, 'no ids'],
    [{ ids: [] }, 'an empty list'],
    [{ ids: ['nope'] }, 'a non-uuid'],
    [{ ids: [ITEM_ID, ITEM_ID] }, 'a repeated id'],
    [{ ids: Array.from({ length: 501 }, () => ITEM_ID) }, 'too many ids'],
  ])('400s %j (%s) without touching the database', async (body, _label) => {
    const sql = createMockSql([]);
    const response = await reorderTaskItems(sql, USER_ID, body);
    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });
});

// A divider (kind = 'divider', migration 0064) is a rule between rows: it
// takes a place in the list's order and moves between projects, and that is
// all. It has no content to search for, so it never reaches Meilisearch.
describe('dividers', () => {
  const DIVIDER = { id: ITEM_ID, kind: 'divider', projectId: PROJECT_ID, content: '' };
  const env = { MEILISEARCH_HOST: 'https://meili.test', MEILISEARCH_API_KEY: 'k' };

  it('creates a divider with no content in the given project, without indexing it', async () => {
    const sql = createMockSql([[{ id: PROJECT_ID }], [DIVIDER]]);

    const response = await createTaskItem(
      sql,
      USER_ID,
      { kind: 'divider', projectId: PROJECT_ID },
      env,
    );

    expect(response.status).toBe(201);
    expect((await response.json()).item.kind).toBe('divider');
    const insert = sql.calls.find((call) => call.text.includes('INSERT INTO task_items'));
    expect(insert.text).toContain("'divider', ?");
    expect(insert.values).toEqual([USER_ID, PROJECT_ID, '']);
    expect(sql.calls.some((call) => call.text.includes('WITH RECURSIVE'))).toBe(false);
  });

  it('stores a trimmed heading on a new divider', async () => {
    const sql = createMockSql([[{ ...DIVIDER, projectId: null, content: 'Later' }]]);

    const response = await createTaskItem(sql, USER_ID, { kind: 'divider', content: '  Later ' });

    expect(response.status).toBe(201);
    const insert = sql.calls.find((call) => call.text.includes('INSERT INTO task_items'));
    expect(insert.values).toEqual([USER_ID, null, 'Later']);
  });

  it('creates an Inbox divider when no project is given', async () => {
    const sql = createMockSql([[{ ...DIVIDER, projectId: null }]]);
    const response = await createTaskItem(sql, USER_ID, { kind: 'divider' });
    expect(response.status).toBe(201);
    expect(sql.calls).toHaveLength(1);
  });

  it('404s a divider in a project the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await createTaskItem(sql, USER_ID, { kind: 'divider', projectId: PROJECT_ID });
    expect(response.status).toBe(404);
  });

  it('refuses a divider as a sub-task', async () => {
    const sql = createMockSql([]);
    const response = await createTaskItem(sql, USER_ID, { kind: 'divider', parentId: ITEM_ID });
    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('refuses a kind it does not know', async () => {
    const sql = createMockSql([]);
    const response = await createTaskItem(sql, USER_ID, { kind: 'section', content: 'x' });
    expect(response.status).toBe(400);
  });

  it('refuses a sub-task under a divider, on create and on reparent', async () => {
    const created = await createTaskItem(createMockSql([[DIVIDER]]), USER_ID, {
      content: 'Step one',
      parentId: ITEM_ID,
    });
    expect(created.status).toBe(400);
    expect((await created.json()).error).toContain('sub-tasks');

    const other = '33333333-3333-4333-8333-333333333333';
    const moved = await updateTaskItem(
      createMockSql([[{ id: other, kind: 'task' }], [DIVIDER]]),
      USER_ID,
      {
        id: other,
        parentId: ITEM_ID,
      },
    );
    expect(moved.status).toBe(400);
  });

  it('moves a divider between projects without a search sync', async () => {
    const sql = createMockSql([[DIVIDER], [{ id: PROJECT_ID }], [{ ...DIVIDER }]]);

    const response = await updateTaskItem(
      sql,
      USER_ID,
      { id: ITEM_ID, projectId: PROJECT_ID },
      env,
    );

    expect(response.status).toBe(200);
    expect(sql.calls.some((call) => call.text.includes('UPDATE task_items'))).toBe(true);
    expect(sql.calls.some((call) => call.text.includes('WITH RECURSIVE'))).toBe(false);
  });

  it('gives a divider a heading, and clears it with blank text', async () => {
    const sql = createMockSql([[DIVIDER], [{ ...DIVIDER, content: 'Later' }]]);

    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, content: ' Later ' });

    expect(response.status).toBe(200);
    expect((await response.json()).item.content).toBe('Later');
    const update = sql.calls.find((call) => call.text.includes('UPDATE task_items t SET'));
    expect(update.values).toContain('Later');
    expect(sql.calls.some((call) => call.text.includes('WITH RECURSIVE'))).toBe(false);

    const clearing = createMockSql([[{ ...DIVIDER, content: 'Later' }], [DIVIDER]]);
    const cleared = await updateTaskItem(clearing, USER_ID, { id: ITEM_ID, content: '' });

    expect(cleared.status).toBe(200);
    const clear = clearing.calls.find((call) => call.text.includes('UPDATE task_items t SET'));
    expect(clear.values).toContain('');
  });

  it('still requires a title on a task', async () => {
    const sql = createMockSql([[{ id: ITEM_ID, kind: 'task', content: 'Ship it' }]]);
    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, content: '   ' });
    expect(response.status).toBe(400);
  });

  it.each([
    [{ dueDate: '2026-09-04' }],
    [{ completed: true }],
    [{ priority: 1 }],
    [{ parentId: '33333333-3333-4333-8333-333333333333' }],
  ])('refuses any other change to a divider: %j', async (change) => {
    const sql = createMockSql([[DIVIDER]]);
    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, ...change });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('divider');
    expect(sql.calls.some((call) => call.text.includes('UPDATE task_items'))).toBe(false);
  });

  it('deletes a divider without touching the search index', async () => {
    const sql = createMockSql([[{ id: ITEM_ID, kind: 'divider', parentId: null }]]);
    vi.stubGlobal('fetch', vi.fn());

    const response = await deleteTaskItem(sql, USER_ID, { id: ITEM_ID }, env);

    expect(response.status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(sql.calls).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('lists the kind of every row', async () => {
    const sql = createMockSql([[DIVIDER]]);
    await getTaskItems(sql, USER_ID, url(`?project=${PROJECT_ID}`));
    expect(sql.calls[0].text).toContain('SELECT t.id, t.kind,');
  });
});

describe('task project invariants', () => {
  it('moves every descendant in the same transaction as its parent', async () => {
    const sql = createMockSql([
      [{ id: ITEM_ID, parentId: null, projectId: PROJECT_ID }],
      [{ id: ITEM_ID, parentId: null, projectId: null }],
      [],
    ]);
    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, projectId: null });
    expect(response.status).toBe(200);
    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(sql.controlCalls[0].values).toEqual([USER_ID]);
    const cascade = sql.calls.find(({ text }) => text.includes('WITH RECURSIVE descendants'));
    expect(cascade.text).toContain('child.parent_id = d.id');
    expect(cascade.text).toContain('UPDATE task_items SET project_id');
    expect(cascade.values).toContain(ITEM_ID);
    expect(cascade.values).toContain(null);
  });

  it('refuses an independent project move of a still-attached child', async () => {
    const sql = createMockSql([
      [{ id: ITEM_ID, parentId: PROJECT_ID, projectId: PROJECT_ID }],
      [{ id: PROJECT_ID, projectId: PROJECT_ID }],
    ]);
    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, projectId: null });
    expect(response.status).toBe(400);
    expect(sql.calls.some(({ text }) => text.includes('UPDATE task_items'))).toBe(false);
  });
});

it('inherits the new parent project when reparenting and moves the descendants too', async () => {
  const parentId = '33333333-3333-4333-8333-333333333333';
  const sql = createMockSql([
    [{ id: ITEM_ID, parentId: null, projectId: null }],
    [{ id: parentId, projectId: PROJECT_ID }],
    [],
    [{ id: ITEM_ID, parentId, projectId: PROJECT_ID }],
    [],
  ]);
  const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, parentId });
  expect(response.status).toBe(200);
  expect((await response.json()).item.projectId).toBe(PROJECT_ID);
  expect(
    sql.calls
      .filter(({ text }) => text.includes('UPDATE task_items'))
      .every(({ values }) => values.includes(PROJECT_ID)),
  ).toBe(true);
});

describe('recurring task items', () => {
  const existing = {
    id: ITEM_ID,
    kind: 'task',
    parentId: null,
    recurrence: 'every 3 days',
    dueDate: '2026-09-05',
    completedAt: null,
  };
  function valueAfter(query, text) {
    return query.values[query.text.split('?').findIndex((part) => part.includes(text))];
  }

  it('creates and returns a normalized recurring task with its first matching date', async () => {
    const item = { ...existing, recurrence: 'every 2nd tuesday', dueDate: '2026-09-08' };
    const sql = createMockSql([[item]]);
    const response = await createTaskItem(sql, USER_ID, {
      content: 'Pay bills',
      recurrence: 'every 2nd Tuesday',
      today: '2026-09-05',
    });
    expect(response.status).toBe(201);
    expect((await response.json()).item).toEqual(item);
    expect(sql.calls[0].values).toContain('2026-09-08');
    expect(sql.calls[0].values).toContain('every 2nd tuesday');
  });

  it.each(['every zero days', {}, 3])(
    'rejects unsupported recurrence %s without inserting',
    async (recurrence) => {
      const sql = createMockSql([]);
      const response = await createTaskItem(sql, USER_ID, {
        content: 'Repeat',
        recurrence,
        today: '2026-09-05',
      });
      expect(response.status).toBe(400);
      expect(sql.calls).toHaveLength(0);
    },
  );

  it('requires a local date when creating a recurring task without a due date', async () => {
    const sql = createMockSql([]);
    expect(
      (await createTaskItem(sql, USER_ID, { content: 'Repeat', recurrence: 'every Monday' }))
        .status,
    ).toBe(400);
  });

  it('uses an explicit due date as the starting date', async () => {
    const sql = createMockSql([[existing]]);
    await createTaskItem(sql, USER_ID, {
      content: 'Repeat',
      recurrence: 'every 3 days',
      dueDate: '2026-10-01',
      today: '2026-09-05',
    });
    expect(sql.calls[0].values).toContain('2026-10-01');
  });

  it('advances overdue tasks along the original schedule and keeps them open', async () => {
    const updated = { ...existing, dueDate: '2026-09-14' };
    const sql = createMockSql([[existing], [updated]]);
    const response = await updateTaskItem(sql, USER_ID, {
      id: ITEM_ID,
      completed: true,
      today: '2026-09-12',
      expectedDueDate: '2026-09-05',
    });
    expect((await response.json()).item).toEqual(updated);
    const query = sql.calls[1];
    expect(valueAfter(query, 'due_date     = CASE WHEN ')).toBe(true);
    expect(query.values).toContain('2026-09-14');
    expect(valueAfter(query, 'completed_at = CASE\n        WHEN ')).toBe(true);
    expect(valueAfter(query, 'today_position = CASE WHEN ')).toBe(true);
    expect(query.text).toContain('t.due_date IS NOT DISTINCT FROM');
    expect(query.text).toContain('t.recurrence IS NOT DISTINCT FROM');
    expect(query.text).toContain('t.user_id =');
  });

  it('rejects a stale completion before updating', async () => {
    const sql = createMockSql([[{ ...existing, dueDate: '2026-09-08' }]]);
    const response = await updateTaskItem(sql, USER_ID, {
      id: ITEM_ID,
      completed: true,
      today: '2026-09-05',
      expectedDueDate: '2026-09-05',
    });
    expect(response.status).toBe(409);
    expect(sql.calls).toHaveLength(1);
  });

  it('reports a concurrent schedule change instead of skipping another occurrence', async () => {
    const sql = createMockSql([[existing], []]);
    const response = await updateTaskItem(sql, USER_ID, {
      id: ITEM_ID,
      completed: true,
      today: '2026-09-05',
      expectedDueDate: '2026-09-05',
    });
    expect(response.status).toBe(409);
  });

  it.each([
    { completed: true },
    { completed: 'true' },
    { completed: true, today: '2026-02-30', expectedDueDate: '2026-09-05' },
    {
      completed: true,
      today: '2026-09-05',
      expectedDueDate: '2026-09-05',
      recurrence: 'every Monday',
    },
    { recurrence: 'whenever' },
  ])('rejects invalid recurring updates %s', async (change) => {
    const sql = createMockSql([[existing]]);
    expect((await updateTaskItem(sql, USER_ID, { id: ITEM_ID, ...change })).status).toBe(400);
    expect(sql.calls).toHaveLength(1);
  });

  it('sets recurrence on an undated task using the caller local date', async () => {
    const sql = createMockSql([[{ ...existing, dueDate: null, recurrence: null }], [existing]]);
    await updateTaskItem(sql, USER_ID, {
      id: ITEM_ID,
      recurrence: 'every Monday',
      today: '2026-09-05',
    });
    expect(sql.calls[1].values).toContain('2026-09-07');
    expect(sql.calls[1].values).toContain('every monday');
  });

  it('removes recurrence without clearing the due date', async () => {
    const sql = createMockSql([[existing], [{ ...existing, recurrence: null }]]);
    const response = await updateTaskItem(sql, USER_ID, { id: ITEM_ID, recurrence: null });
    expect((await response.json()).item.dueDate).toBe('2026-09-05');
    expect(valueAfter(sql.calls[1], 'due_date     = CASE WHEN ')).toBe(false);
    expect(valueAfter(sql.calls[1], 'recurrence = CASE WHEN ')).toBe(true);
  });

  it('clears recurrence when the date is removed', async () => {
    const sql = createMockSql([[existing], [{ ...existing, dueDate: null, recurrence: null }]]);
    await updateTaskItem(sql, USER_ID, { id: ITEM_ID, dueDate: null });
    const query = sql.calls[1];
    const index = query.text
      .split('?')
      .findIndex((part) => part.includes('recurrence = CASE WHEN '));
    expect(query.values.slice(index, index + 2)).toEqual([true, null]);
  });

  it('does not allow recurrence on a divider', async () => {
    const sql = createMockSql([[{ id: ITEM_ID, kind: 'divider' }]]);
    expect(
      (await updateTaskItem(sql, USER_ID, { id: ITEM_ID, recurrence: 'every day' })).status,
    ).toBe(400);
  });
});

it('preserves database timestamp precision for reopening completed tasks', async () => {
  const completedAt = '2026-09-05 12:34:56.123456+00';
  const sql = createMockSql([[{ id: ITEM_ID, completedAt }], [{ id: ITEM_ID, completedAt: null }]]);
  expect((await updateTaskItem(sql, USER_ID, { id: ITEM_ID, completed: false })).status).toBe(200);
  expect(sql.calls[0].text).toContain('completed_at::text AS "completedAt"');
  expect(sql.calls[1].values).toContain(completedAt);
});

it('rejects completing a stale recurring occurrence after recurrence was removed', async () => {
  const sql = createMockSql([[{ id: ITEM_ID, recurrence: null, dueDate: '2026-09-05' }]]);
  const response = await updateTaskItem(sql, USER_ID, {
    id: ITEM_ID,
    completed: true,
    today: '2026-09-05',
    expectedDueDate: '2026-09-05',
  });
  expect(response.status).toBe(409);
  expect(sql.calls).toHaveLength(1);
});
