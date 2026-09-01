// The three corpora Meilisearch indexes, and the index descriptors that
// describe them (searchable/filterable attributes, the embedder, and how to
// turn a Postgres row into a Meilisearch document). Shared by
// reindex-meili.js and repair-search-drift.js so both scripts agree on what
// "documents", "messages" and "task_items" mean.

import { DOCUMENTS_INDEX } from '../../shared/meili/documents.js';
import { MESSAGES_INDEX } from '../../shared/meili/messages.js';
import { TASKS_INDEX } from '../../shared/meili/tasks.js';

/** @typedef {'documents' | 'messages' | 'task_items'} Target */

/** @type {Target[]} */
export const TARGETS = ['documents', 'messages', 'task_items'];

export const DESCRIPTORS = {
  documents: DOCUMENTS_INDEX,
  messages: MESSAGES_INDEX,
  task_items: TASKS_INDEX,
};

/**
 * Parses the optional target argument reindex-meili.js accepts on argv:
 * "documents", "messages", "task_items", or nothing (all, the default). Pure
 * so it's testable without a database or Meilisearch.
 *
 * @param {string[]} argv e.g. process.argv.slice(2)
 * @returns {Target[]}
 */
export function parseTargets(argv) {
  const [target] = argv;
  if (!target) return TARGETS;
  if (!TARGETS.includes(/** @type {Target} */ (target))) {
    throw new Error(`Unknown target "${target}". Expected one of: ${TARGETS.join(', ')}`);
  }
  return [/** @type {Target} */ (target)];
}
