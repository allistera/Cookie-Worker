import * as z from 'zod';
import { ToolInputError } from '../results.js';
import { provided, READ_ONLY } from './common.js';

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
    name: 'cookie_list_tasks',
    title: 'List tasks',
    description:
      'Lists tasks in a project, the inbox, today or a label, one page at a time. ' +
      '`today` shows overdue tasks plus those due by `date`.',
    inputSchema: z.object({
      project: z
        .string()
        .default('inbox')
        .describe('Project id, "inbox", "today" or "label:<name>"'),
      date: date.optional().describe('The owner’s current date; required when project is today'),
      includeCompleted: z.boolean().default(false),
      cursor: z.string().optional().describe('nextCursor from a previous page'),
    }),
    outputSchema: z.object({ items: z.array(item), nextCursor: z.string().nullable() }),
    annotations: READ_ONLY,
    async run({ project, date: day, includeCompleted, cursor }, api) {
      if (project === 'today' && !day) {
        throw new ToolInputError('date is required when project is today');
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
