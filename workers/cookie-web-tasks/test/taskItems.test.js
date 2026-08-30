import { describe, expect, it } from 'vitest';
import { createTaskItem, deleteTaskItem, getTaskItems, updateTaskItem } from '../src/taskItems.js';
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
    expect(sql.calls[0].text).toContain('t.created_at ASC');
    expect(sql.calls[0].values).toEqual([USER_ID, false, null, false, PROJECT_ID, false, false]);
  });

  // Inbox is a rule, not a row: it means "belongs to no project".
  it('treats project=inbox as project_id IS NULL', async () => {
    const sql = createMockSql([[]]);
    await getTaskItems(sql, USER_ID, url('?project=inbox'));

    expect(sql.calls[0].values).toEqual([USER_ID, false, null, true, null, false, false]);
    expect(sql.calls[0].values).not.toContain('inbox');
  });

  it('includes completed tasks when asked', async () => {
    const sql = createMockSql([[]]);
    await getTaskItems(sql, USER_ID, url('?project=inbox&completed=1'));

    expect(sql.calls[0].values).toEqual([USER_ID, false, null, true, null, true, false]);
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

  // Sub-task creation isn't implemented: a request carrying parentId must be
  // rejected loudly rather than silently dropping the field and creating a
  // top-level Inbox task.
  it('rejects a parentId, which the handler does not implement yet', async () => {
    const sql = createMockSql([]);
    const response = await createTaskItem(sql, USER_ID, {
      content: 'Ship it',
      parentId: ITEM_ID,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/sub-task/i);
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
    expect(sql.calls[0].values).toEqual([USER_ID, true, '2026-08-29', false, null, false, true]);
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

    expect(sql.calls[0].values).toEqual([USER_ID, true, '2026-08-29', false, null, true, true]);
  });

  it('does not treat today as a project id', async () => {
    const sql = createMockSql([[]]);

    await getTaskItems(sql, USER_ID, url('?project=today&date=2026-08-29'));

    expect(sql.calls[0].values).not.toContain('today');
  });
});
