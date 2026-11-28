import * as z from 'zod';
import { ToolInputError } from '../results.js';
import { provided, READ_ONLY, UNTRUSTED } from './common.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const id = z.string().uuid();

// Every nullable column of a task row can be null in a real response, so the output
// schema allows it; a too-strict schema would report a successful write as a failure.
const item = z
  .object({
    id: z.string(),
    kind: z.enum(['task', 'divider']),
    projectId: z.string().nullable(),
    parentId: z.string().nullable(),
    content: z.string(),
    description: z.string().nullable(),
    recurrence: z.string().nullable(),
    dueTime: z.string().nullable(),
    timeZone: z.string().nullable(),
    labels: z.array(z.string()),
    dueDate: z.string().nullable(),
    priority: z.number(),
    position: z.number(),
    todayPosition: z.number().nullable(),
    completedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .passthrough();

const label = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[^\s@#]+$/, 'No spaces, @ or #');

/** Fields shared by create and update; update makes them all optional. */
const taskFields = {
  description: z.string().max(10000).nullable().optional(),
  projectId: id.nullable().optional().describe('Project id; null for the inbox'),
  parentId: id.nullable().optional().describe('Parent task id to make this a sub-task'),
  dueDate: date.nullable().optional().describe('YYYY-MM-DD; null clears it'),
  dueTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')
    .nullable()
    .optional()
    .describe('24-hour HH:MM; needs dueDate and timeZone'),
  timeZone: z.string().max(100).optional().describe('IANA time zone for dueTime'),
  labels: z.array(label).max(20).optional(),
  priority: z.number().int().min(1).max(4).nullable().optional().describe('1 is most urgent'),
  recurrence: z.string().max(100).nullable().optional().describe('Repeat rule, e.g. "every week"'),
  today: date.optional().describe('The owner’s current date, YYYY-MM-DD'),
};

const project = z.record(z.string(), z.unknown());

/** A task as the date window returns it: the fields a schedule needs. */
const datedItem = z
  .object({
    id: z.string(),
    projectId: z.string().nullable(),
    parentId: z.string().nullable(),
    content: z.string(),
    dueDate: z.string(),
    dueTime: z.string().nullable(),
    timeZone: z.string().nullable(),
    priority: z.number(),
    recurrence: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .passthrough();

/** @type {import('./types.js').ToolDefinition[]} */
export const tools = [
  {
    name: 'cookie_list_projects',
    title: 'List task projects',
    description: 'Lists the owner’s task projects (id, parent, name). The inbox is not a project.',
    inputSchema: z.object({}),
    outputSchema: z.object({ projects: z.array(z.record(z.string(), z.unknown())) }),
    annotations: READ_ONLY,
    async run(_args, api) {
      const body = await api.tasks.get('/projects');
      return { projects: body.projects ?? [] };
    },
  },
  {
    name: 'cookie_create_project',
    title: 'Create a task project',
    description: 'Creates a task project, at the top level or under a parent project.',
    inputSchema: z.object({
      name: z.string().trim().min(1).max(120),
      parentId: id.optional().describe('Parent project id, to nest the new project'),
    }),
    outputSchema: z.object({ project }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(fields, api) {
      const body = await api.tasks.post('/projects', provided(fields));
      return { project: body.project };
    },
  },
  {
    name: 'cookie_update_project',
    title: 'Update a task project',
    description:
      'Changes only the fields you pass: rename a project, move it under another ' +
      '(parentId null moves it to the top level), set its description or favourite it.',
    inputSchema: z.object({
      id: id.describe('Project id'),
      name: z.string().trim().min(1).max(120).optional(),
      parentId: id.nullable().optional().describe('New parent project id; null for the top level'),
      description: z.string().max(10000).nullable().optional().describe('null clears it'),
      isFavorite: z.boolean().optional(),
    }),
    outputSchema: z.object({ project }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run({ id: projectId, ...fields }, api) {
      const changes = provided(fields);
      if (Object.keys(changes).length === 0) {
        throw new ToolInputError('Pass at least one field to change');
      }
      const body = await api.tasks.patch('/projects', { id: projectId, ...changes });
      return { project: body.project };
    },
  },
  {
    name: 'cookie_delete_project',
    title: 'Delete a task project',
    description:
      'Permanently deletes a project with every sub-project and task inside it. ' +
      'Move tasks out first if they should be kept.',
    inputSchema: z.object({ id: id.describe('Project id') }),
    outputSchema: z.object({ deleted: z.literal(true), id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async run({ id: projectId }, api) {
      await api.tasks.delete('/projects', { id: projectId });
      return { deleted: true, id: projectId };
    },
  },
  {
    name: 'cookie_list_task_labels',
    title: 'List task labels',
    description:
      'Lists the owner’s task labels with their colour and how many tasks carry each. ' +
      'These are separate from mail labels. Pass a name to cookie_list_tasks as "label:<name>".',
    inputSchema: z.object({}),
    outputSchema: z.object({ labels: z.array(z.record(z.string(), z.unknown())) }),
    annotations: READ_ONLY,
    async run(_args, api) {
      const body = await api.tasks.get('/task-labels');
      return { labels: body.labels ?? [] };
    },
  },
  {
    name: 'cookie_list_task_filters',
    title: 'List saved task filters',
    description:
      'Lists the owner’s saved task filters (id, name and rules). ' +
      'Pass an id to cookie_list_tasks as "filter:<id>" to list the tasks it matches.',
    inputSchema: z.object({}),
    outputSchema: z.object({ filters: z.array(z.record(z.string(), z.unknown())) }),
    annotations: READ_ONLY,
    async run(_args, api) {
      const body = await api.tasks.get('/task-filters');
      return { filters: body.filters ?? [] };
    },
  },
  {
    name: 'cookie_list_tasks',
    title: 'List tasks',
    description:
      'Lists tasks in a project, the inbox, today, a label or a saved filter, one page at a ' +
      'time. `today` shows overdue tasks plus those due by `date`.',
    inputSchema: z.object({
      project: z
        .string()
        .default('inbox')
        .describe('Project id, "inbox", "today", "label:<name>" or "filter:<id>"'),
      date: date
        .optional()
        .describe('The owner’s current date; required when project is today or a filter'),
      includeCompleted: z.boolean().default(false),
      cursor: z.string().optional().describe('nextCursor from a previous page'),
    }),
    outputSchema: z.object({ items: z.array(item), nextCursor: z.string().nullable() }),
    annotations: READ_ONLY,
    async run({ project, date: day, includeCompleted, cursor }, api) {
      if ((project === 'today' || project.startsWith('filter:')) && !day) {
        throw new ToolInputError('date is required when project is today or a filter');
      }
      const body = await api.tasks.get('/task-items', {
        view: 'page',
        project,
        date: day,
        completed: includeCompleted ? '1' : undefined,
        after: cursor,
      });
      return { items: body.items ?? [], nextCursor: body.nextCursor ?? null };
    },
  },
  {
    name: 'cookie_get_task',
    title: 'Get a task',
    description:
      'Reads one task in full with its sub-tasks (100 a page) and how many of them are done.',
    inputSchema: z.object({
      id: id.describe('Task id'),
      cursor: z.string().optional().describe('nextCursor from a previous page of sub-tasks'),
    }),
    outputSchema: z.object({
      item,
      subtasks: z.array(item),
      counts: z.object({ total: z.number(), done: z.number() }),
      nextCursor: z.string().nullable(),
    }),
    annotations: READ_ONLY,
    async run({ id: taskId, cursor }, api) {
      const body = await api.tasks.get('/task-items', {
        view: 'detail',
        id: taskId,
        after: cursor,
      });
      return {
        item: body.item,
        subtasks: body.subtasks ?? [],
        counts: body.counts ?? { total: 0, done: 0 },
        nextCursor: body.nextCursor ?? null,
      };
    },
  },
  {
    name: 'cookie_list_tasks_by_date',
    title: 'List tasks due in a date range',
    description:
      'Lists tasks due from one date to another, across every project, in due order. ' +
      'The range can span at most 100 days. Tasks put off to Someday carry the date ' +
      '9999-12-31 and tasks with no date are not included.',
    inputSchema: z.object({
      from: date.describe('First due date, YYYY-MM-DD'),
      to: date.describe('Last due date, YYYY-MM-DD'),
      includeCompleted: z.boolean().default(false),
    }),
    outputSchema: z.object({ items: z.array(datedItem) }),
    annotations: READ_ONLY,
    async run({ from, to, includeCompleted }, api) {
      const body = await api.tasks.get('/task-items', {
        view: 'calendar',
        from,
        to,
        completed: includeCompleted ? '1' : undefined,
      });
      return { items: body.items ?? [] };
    },
  },
  {
    name: 'cookie_search_tasks',
    title: 'Search tasks',
    description:
      'Searches open tasks by meaning and keywords across every project. ' +
      'Completed tasks are not searched.',
    inputSchema: z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    outputSchema: z.object({
      tasks: z.array(
        z
          .object({
            id: z.string(),
            content: z.string(),
            description: z.string().nullable(),
            projectId: z.string().nullable(),
            dueDate: z.string().nullable(),
            completedAt: z.string().nullable(),
          })
          .passthrough(),
      ),
    }),
    annotations: READ_ONLY,
    async run({ query, limit }, api) {
      const body = await api.search.get('/search', { q: query, scope: 'tasks', limit });
      return {
        tasks: (body.results ?? [])
          .filter((/** @type {any} */ hit) => hit.type === 'task')
          .map(({ type: _type, ...task }) => task),
      };
    },
  },
  {
    name: 'cookie_list_task_comments',
    title: 'List a task’s comments',
    description:
      `Reads a task’s discussion thread, oldest first, 100 a page. An attachment is described ` +
      `by name, type and size; its contents are not returned. ${UNTRUSTED}`,
    inputSchema: z.object({
      taskId: id.describe('Task id'),
      cursor: z.string().optional().describe('nextCursor from a previous page'),
    }),
    outputSchema: z.object({
      comments: z.array(z.record(z.string(), z.unknown())),
      nextCursor: z.string().nullable(),
    }),
    annotations: READ_ONLY,
    async run({ taskId, cursor }, api) {
      const body = await api.tasks.get('/task-comments', { task: taskId, after: cursor });
      return { comments: body.comments ?? [], nextCursor: body.nextCursor ?? null };
    },
  },
  {
    name: 'cookie_create_task',
    title: 'Create a task',
    description:
      'Creates a task in the inbox or a project. A repeating task needs dueDate or today.',
    inputSchema: z.object({ content: z.string().min(1).max(500), ...taskFields }),
    outputSchema: z.object({ item }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(fields, api) {
      const body = await api.tasks.post('/task-items', provided(fields));
      return { item: body.item };
    },
  },
  {
    name: 'cookie_update_task',
    title: 'Update a task',
    description:
      'Changes only the fields you pass; null clears a nullable field. Completing a recurring ' +
      'task advances it to the next occurrence and needs `today` and `expectedDueDate` ' +
      '(the task’s current dueDate).',
    inputSchema: z.object({
      id: id.describe('Task id'),
      content: z.string().min(1).max(500).optional(),
      ...taskFields,
      completed: z.boolean().optional().describe('true completes the task, false reopens it'),
      expectedDueDate: date.optional().describe('Current dueDate, to complete a recurring task'),
    }),
    outputSchema: z.object({ item }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run({ id: taskId, ...fields }, api) {
      const changes = provided(fields);
      if (Object.keys(changes).length === 0) {
        throw new ToolInputError('Pass at least one field to change');
      }
      const body = await api.tasks.patch('/task-items', { id: taskId, ...changes });
      return { item: body.item };
    },
  },
  {
    name: 'cookie_delete_task',
    title: 'Delete a task',
    description: 'Permanently deletes a task and its sub-tasks.',
    inputSchema: z.object({ id: id.describe('Task id') }),
    outputSchema: z.object({ deleted: z.literal(true), id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async run({ id: taskId }, api) {
      await api.tasks.delete('/task-items', { id: taskId });
      return { deleted: true, id: taskId };
    },
  },
];
