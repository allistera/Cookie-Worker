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

  test('cookie_list_tasks lists a saved filter, which needs the date too', async () => {
    const api = fakeApi();
    api.tasks.get.mockResolvedValue({ items: [item], nextCursor: null });
    const tool = byName(tools, 'cookie_list_tasks');
    await expect(
      tool.run(tool.inputSchema.parse({ project: `filter:${PROJECT}` }), api),
    ).rejects.toThrow(ToolInputError);
    expect(api.tasks.get).not.toHaveBeenCalled();

    await call('cookie_list_tasks', { project: `filter:${PROJECT}`, date: '2026-11-28' }, api);
    expect(api.tasks.get).toHaveBeenCalledWith('/task-items', {
      view: 'page',
      project: `filter:${PROJECT}`,
      date: '2026-11-28',
      completed: undefined,
      after: undefined,
    });
  });

  test('cookie_get_task returns the task, a page of sub-tasks and the done count', async () => {
    const api = fakeApi();
    const subtask = { ...item, id: PROJECT, parentId: TASK, content: 'Find the reference' };
    api.tasks.get.mockResolvedValue({
      item: { ...item, summary: false },
      subtasks: [subtask],
      counts: { total: 3, done: 1 },
      nextCursor: 'next',
    });
    const result = await call('cookie_get_task', { id: TASK, cursor: 'page-2' }, api);
    expect(api.tasks.get).toHaveBeenCalledWith('/task-items', {
      view: 'detail',
      id: TASK,
      after: 'page-2',
    });
    expect(result).toEqual({
      item: { ...item, summary: false },
      subtasks: [subtask],
      counts: { total: 3, done: 1 },
      nextCursor: 'next',
    });
    expect(() => byName(tools, 'cookie_get_task').inputSchema.parse({ id: 'nope' })).toThrow();
  });

  test('cookie_list_tasks_by_date asks for the window and maps includeCompleted', async () => {
    const api = fakeApi();
    const dated = {
      id: TASK,
      projectId: null,
      parentId: null,
      content: 'Pay rent',
      dueDate: '2026-12-01',
      dueTime: null,
      durationMinutes: 30,
      timeZone: null,
      priority: 4,
      recurrence: null,
      completedAt: null,
    };
    api.tasks.get.mockResolvedValue({ items: [dated] });
    const range = { from: '2026-12-01', to: '2026-12-07' };
    expect(await call('cookie_list_tasks_by_date', range, api)).toEqual({ items: [dated] });
    expect(api.tasks.get).toHaveBeenLastCalledWith('/task-items', {
      view: 'calendar',
      ...range,
      completed: undefined,
    });
    await call('cookie_list_tasks_by_date', { ...range, includeCompleted: true }, api);
    expect(api.tasks.get).toHaveBeenLastCalledWith('/task-items', {
      view: 'calendar',
      ...range,
      completed: '1',
    });
    expect(() =>
      byName(tools, 'cookie_list_tasks_by_date').inputSchema.parse({
        from: 'Monday',
        to: 'Friday',
      }),
    ).toThrow();
  });

  test('cookie_search_tasks searches the tasks scope and returns only task hits', async () => {
    const api = fakeApi();
    const hit = {
      id: TASK,
      content: 'Pay rent',
      description: null,
      projectId: null,
      dueDate: null,
      completedAt: null,
    };
    api.search.get.mockResolvedValue({
      results: [
        { type: 'task', ...hit },
        { type: 'document', id: PROJECT, title: 'Rent notes' },
      ],
    });
    expect(await call('cookie_search_tasks', { query: 'rent' }, api)).toEqual({ tasks: [hit] });
    expect(api.search.get).toHaveBeenCalledWith('/search', {
      q: 'rent',
      scope: 'tasks',
      limit: 20,
    });
    expect(() =>
      byName(tools, 'cookie_search_tasks').inputSchema.parse({ query: 'rent', limit: 51 }),
    ).toThrow();
  });

  test('cookie_list_task_comments reads one page of a task’s thread', async () => {
    const api = fakeApi();
    const comment = {
      id: PROJECT,
      taskId: TASK,
      body: 'Paid on Friday',
      attachment: { name: 'receipt.pdf', mimeType: 'application/pdf', sizeBytes: 1200 },
      mine: true,
      editedAt: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    api.tasks.get.mockResolvedValue({ comments: [comment], nextCursor: null });
    const result = await call('cookie_list_task_comments', { taskId: TASK, cursor: 'c' }, api);
    expect(api.tasks.get).toHaveBeenCalledWith('/task-comments', { task: TASK, after: 'c' });
    expect(result).toEqual({ comments: [comment], nextCursor: null });
  });

  test('cookie_list_task_labels and cookie_list_task_filters return what the API holds', async () => {
    const api = fakeApi();
    const labels = [{ id: PROJECT, name: 'errand', color: '#5e6ad2', taskCount: 4 }];
    api.tasks.get.mockResolvedValueOnce({ labels });
    expect(await call('cookie_list_task_labels', {}, api)).toEqual({ labels });
    expect(api.tasks.get).toHaveBeenLastCalledWith('/task-labels');

    const filters = [
      { id: PROJECT, name: 'Urgent', match: 'all', rules: [{ field: 'priority', value: 1 }] },
    ];
    api.tasks.get.mockResolvedValueOnce({ revision: 3, filters });
    expect(await call('cookie_list_task_filters', {}, api)).toEqual({ filters });
    expect(api.tasks.get).toHaveBeenLastCalledWith('/task-filters');
  });

  test('cookie_create_project sends the name and, when given, the parent', async () => {
    const api = fakeApi();
    const created = { id: PROJECT, parentId: null, name: 'Home', taskCount: 0 };
    api.tasks.post.mockResolvedValue({ project: created });
    expect(await call('cookie_create_project', { name: '  Home  ' }, api)).toEqual({
      project: created,
    });
    expect(api.tasks.post).toHaveBeenLastCalledWith('/projects', { name: 'Home' });
    await call('cookie_create_project', { name: 'Garden', parentId: PROJECT }, api);
    expect(api.tasks.post).toHaveBeenLastCalledWith('/projects', {
      name: 'Garden',
      parentId: PROJECT,
    });
    expect(() =>
      byName(tools, 'cookie_create_project').inputSchema.parse({ name: '  ' }),
    ).toThrow();
  });

  test('cookie_update_project sends only the changes and keeps an explicit null', async () => {
    const api = fakeApi();
    const updated = { id: PROJECT, parentId: null, name: 'Home', isFavorite: true };
    api.tasks.patch.mockResolvedValue({ project: updated });
    const result = await call(
      'cookie_update_project',
      { id: PROJECT, parentId: null, isFavorite: true },
      api,
    );
    expect(api.tasks.patch).toHaveBeenCalledWith('/projects', {
      id: PROJECT,
      parentId: null,
      isFavorite: true,
    });
    expect(result).toEqual({ project: updated });

    const tool = byName(tools, 'cookie_update_project');
    await expect(tool.run(tool.inputSchema.parse({ id: PROJECT }), api)).rejects.toThrow(
      ToolInputError,
    );
    expect(api.tasks.patch).toHaveBeenCalledOnce();
  });

  test('cookie_delete_project deletes by id and is marked destructive', async () => {
    const api = fakeApi();
    api.tasks.delete.mockResolvedValue({ ok: true });
    expect(await call('cookie_delete_project', { id: PROJECT }, api)).toEqual({
      deleted: true,
      id: PROJECT,
    });
    expect(api.tasks.delete).toHaveBeenCalledWith('/projects', { id: PROJECT });
    expect(byName(tools, 'cookie_delete_project').annotations.destructiveHint).toBe(true);
  });

  test('the tools that only read are marked read-only', () => {
    const readOnly = tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name);
    expect(readOnly).toEqual([
      'cookie_list_projects',
      'cookie_list_task_labels',
      'cookie_list_task_filters',
      'cookie_list_tasks',
      'cookie_get_task',
      'cookie_list_tasks_by_date',
      'cookie_search_tasks',
      'cookie_list_task_comments',
    ]);
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
