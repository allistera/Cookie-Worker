import { describe, expect, it } from 'vitest';
import { createTaskItem, getTaskItems } from '../src/taskItems.js';
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
    expect(sql.calls[0].text).toContain('ORDER BY t.created_at ASC');
    expect(sql.calls[0].values).toEqual([USER_ID, false, PROJECT_ID, false]);
  });

  // Inbox is a rule, not a row: it means "belongs to no project".
  it('treats project=inbox as project_id IS NULL', async () => {
    const sql = createMockSql([[]]);
    await getTaskItems(sql, USER_ID, url('?project=inbox'));

    expect(sql.calls[0].values).toEqual([USER_ID, true, null, false]);
    expect(sql.calls[0].values).not.toContain('inbox');
  });

  it('includes completed tasks when asked', async () => {
    const sql = createMockSql([[]]);
    await getTaskItems(sql, USER_ID, url('?project=inbox&completed=1'));

    expect(sql.calls[0].values).toEqual([USER_ID, true, null, true]);
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
});
