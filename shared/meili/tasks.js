import { EMBEDDER, readableTime } from './embedder.js';

/**
 * The task-items index — one document per top-level task. A sub-task is not
 * its own document: its title rides along in the parent's `subtasks` array,
 * so a hit is always a task the Tasks view can actually open (the detail
 * panel resolves a task out of the loaded list, and only top-level tasks are
 * listed). See cookie-web-tasks/src/taskItemMeiliSync.js, which walks a
 * sub-task up to its root before indexing.
 *
 * Completed tasks stay in the index (their doc just carries completed: true)
 * so completing and un-completing a task never has to flip between add and
 * delete — search callers filter `completed = false` at query time instead.
 */
export const TASKS_INDEX = {
  name: 'task_items',
  primaryKey: 'id',
  searchable: ['content', 'description', 'subtasks'],
  filterable: ['user_id', 'completed', 'updated_at'],
  sortable: ['updated_at'],
  semanticRatio: 0.5,
  // Title and description only, mirroring DOCUMENTS_INDEX's tags: sub-task
  // titles stay keyword-searchable but out of the vector, so a sub-task
  // never dilutes what the task itself is about.
  embedder: {
    ...EMBEDDER,
    documentTemplate: '{{doc.content}}\n\n{{doc.description}}',
  },
  // Conversational search's view of the index; see MESSAGES_INDEX.chat.
  // Completed tasks stay visible to the model (unlike the search page), so
  // "what did I finish last week" can be answered.
  chat: {
    description:
      "The user's to-do tasks: the task text, its description, sub-task titles and " +
      'whether it is completed. Search here for what the user has to do or has done.',
    documentTemplate:
      'Task "{{doc.content}}" ({% if doc.completed %}completed{% else %}open{% endif %}' +
      '{% if doc.updated_date %}, last changed {{doc.updated_date}}{% endif %}): ' +
      '{{ doc.description | strip }}\nSub-tasks: {{ doc.subtasks | join: "; " }}',
    documentTemplateMaxBytes: 800,
    // See DOCUMENTS_INDEX.chat: unrelated tasks scored 0.26 to 0.5 for a mail
    // subject, a loosely related one 0.5 and a related one 0.64.
    searchParameters: {
      hybrid: { embedder: 'default', semanticRatio: 0.5 },
      limit: 5,
      rankingScoreThreshold: 0.3,
    },
  },
  toDocument: (row) => ({
    id: row.id,
    user_id: row.user_id,
    content: row.content ?? '',
    description: row.description ?? '',
    subtasks: row.subtasks ?? [],
    completed: Boolean(row.completed_at),
    // Numeric so Meilisearch can sort and filter on it.
    updated_at: row.updated_at ? new Date(row.updated_at).getTime() : 0,
    // Display-only twin of updated_at for the chat model (see readableTime).
    updated_date: readableTime(row.updated_at),
  }),
};
