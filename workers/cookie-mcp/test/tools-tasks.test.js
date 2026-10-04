import { describe, expect, test } from 'vitest';
import { ToolInputError } from '../src/results.js';
import { tools } from '../src/tools/tasks.js';
import { byName, fakeApi } from './helpers.js';

const TASK = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

/** @param {string} name @param {any} args @param {any} api */
async function call(name, args, api) {
  const tool = byName(tools, name);
  const result = await tool.run(tool.inputSchema.parse(args), api);
  tool.outputSchema.parse(result);
  return result;
}

const item = {
  id: TASK,
  kind: 'task',
  projectId: null,
  parentId: null,
  content: 'Pay rent',
  description: null,
  recurrence: null,
  dueTime: null,
  timeZone: null,
  labels: [],
  dueDate: null,
  priority: 4,
  position: 1024,
  todayPosition: null,
  completedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
};
const divider = { ...item, id: PROJECT, kind: 'divider', content: 'Week 2', priority: 1 };

describe('tasks tools', () => {
  test('cookie_list_projects returns projects with null parents', async () => {
    const api = fakeApi();
    const projects = [
      { id: PROJECT, parentId: null, name: 'Home', description: null, createdAt: '2026-10-01' },
    ];
    api.tasks.get.mockResolvedValue({ projects });
    const result = await call('cookie_list_projects', {}, api);
    expect(api.tasks.get).toHaveBeenCalledWith('/projects');
    expect(result).toEqual({ projects });
  });

  test('cookie_list_tasks defaults to inbox and returns dividers and the cursor', async () => {
    const api = fakeApi();
    api.tasks.get.mockResolvedValue({
      items: [
        { ...item, summary: true },
        { ...divider, summary: true },
      ],
      nextCursor: null,
    });
    const result = await call('cookie_list_tasks', {}, api);
    expect(api.tasks.get).toHaveBeenCalledWith('/task-items', {
      view: 'page',
      project: 'inbox',
      date: undefined,
      completed: undefined,
      after: undefined,
    });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  test('cookie_list_tasks today requires a date', async () => {
    const api = fakeApi();
    const tool = byName(tools, 'cookie_list_tasks');
    await expect(tool.run(tool.inputSchema.parse({ project: 'today' }), api)).rejects.toThrow(
      ToolInputError,
    );
    expect(api.tasks.get).not.toHaveBeenCalled();
  });

  test('cookie_list_tasks maps includeCompleted to completed=1 and passes the cursor', async () => {
    const api = fakeApi();
    api.tasks.get.mockResolvedValue({ items: [], nextCursor: 'abc' });
    const result = await call(
      'cookie_list_tasks',
      { project: 'today', date: '2026-10-04', includeCompleted: true, cursor: 'c1' },
      api,
    );
    expect(api.tasks.get).toHaveBeenCalledWith('/task-items', {
      view: 'page',
      project: 'today',
      date: '2026-10-04',
      completed: '1',
      after: 'c1',
    });
    expect(result).toEqual({ items: [], nextCursor: 'abc' });
  });

  test('cookie_create_task posts the fields and returns the item', async () => {
    const api = fakeApi();
    api.tasks.post.mockResolvedValue({ item });
    const fields = { content: 'Pay rent', priority: 4, labels: ['home'] };
    const result = await call('cookie_create_task', fields, api);
    expect(api.tasks.post).toHaveBeenCalledWith('/task-items', fields);
    expect(result).toEqual({ item });
  });

  test('cookie_create_task rejects a non-integer priority', () => {
    const tool = byName(tools, 'cookie_create_task');
    expect(() => tool.inputSchema.parse({ content: 'x', priority: 2.5 })).toThrow();
    expect(() => tool.inputSchema.parse({ content: 'x', priority: 5 })).toThrow();
  });

  test('cookie_update_task passes only provided keys, including explicit nulls', async () => {
    const api = fakeApi();
    api.tasks.patch.mockResolvedValue({ item });
    await call('cookie_update_task', { id: TASK, dueDate: null, description: null }, api);
    expect(api.tasks.patch).toHaveBeenCalledWith('/task-items', {
      id: TASK,
      dueDate: null,
      description: null,
    });
  });

  test('cookie_update_task completes a recurring task with today and expectedDueDate', async () => {
    const api = fakeApi();
    api.tasks.patch.mockResolvedValue({
      item: { ...item, recurrence: 'every week', dueDate: '2026-10-11' },
    });
    await call(
      'cookie_update_task',
      { id: TASK, completed: true, today: '2026-10-04', expectedDueDate: '2026-10-04' },
      api,
    );
    expect(api.tasks.patch).toHaveBeenCalledWith('/task-items', {
      id: TASK,
      completed: true,
      today: '2026-10-04',
      expectedDueDate: '2026-10-04',
    });
  });

  test('cookie_update_task with nothing to change throws', async () => {
    const api = fakeApi();
    const tool = byName(tools, 'cookie_update_task');
    await expect(tool.run(tool.inputSchema.parse({ id: TASK }), api)).rejects.toThrow(
      ToolInputError,
    );
    expect(api.tasks.patch).not.toHaveBeenCalled();
  });

  test('cookie_delete_task deletes by id', async () => {
    const api = fakeApi();
    api.tasks.delete.mockResolvedValue({ ok: true });
    const result = await call('cookie_delete_task', { id: TASK }, api);
    expect(api.tasks.delete).toHaveBeenCalledWith('/task-items', { id: TASK });
    expect(result).toEqual({ deleted: true, id: TASK });
  });
});
