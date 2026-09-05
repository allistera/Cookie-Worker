import { TASKS_INDEX } from '../../../shared/meili/tasks.js';
import {
  addDocuments as addDocumentsDefault,
  deleteDocuments as deleteDocumentsDefault,
  meiliAvailable,
} from '../../../shared/meili.js';

/**
 * Best-effort push of one task's search document. Mirrors
 * documentMeiliSync.js: reads the authoritative rows and pushes, and never
 * throws — a task write must not fail because search indexing did. A miss is
 * repaired by the drift sweep, which is what search_indexed_at exists for.
 *
 * The id may be any row in a task tree: only top-level tasks are indexed
 * (TASKS_INDEX carries sub-task titles on the parent), so the sync walks up
 * to the root first. Writing a sub-task therefore re-pushes its parent.
 * Dividers (kind = 'divider', migration 0064) have nothing to find and are
 * never pushed.
 *
 * @param {import('postgres').Sql} sql
 * @param {any} env
 * @param {string} taskId
 * @param {{addDocuments?: Function}} [deps]
 */
export async function syncTaskItemToMeili(sql, env, taskId, deps = {}) {
  if (env?.deferSearchSync) {
    env.deferSearchSync((freshSql) =>
      syncTaskItemToMeili(freshSql, { ...env, deferSearchSync: undefined }, taskId, deps),
    );
    return;
  }
  if (!env || !meiliAvailable(env)) return;
  const addDocs = deps.addDocuments ?? addDocumentsDefault;

  try {
    const [root] = await sql`
      WITH RECURSIVE up AS (
        SELECT id, parent_id FROM task_items WHERE id = ${taskId}
        UNION ALL
        SELECT t.id, t.parent_id FROM task_items t JOIN up ON t.id = up.parent_id
      )
      SELECT id FROM up WHERE parent_id IS NULL
    `;
    if (!root) return;

    const [row] = await sql`
      SELECT t.id, t.xmin::text AS row_version,
             COALESCE(string_agg(c.id::text || ':' || c.xmin::text, ',' ORDER BY c.id), '') AS child_versions, t.user_id, t.content, t.description, t.completed_at, t.updated_at,
             COALESCE(array_agg(c.content ORDER BY c.created_at) FILTER (WHERE c.id IS NOT NULL),
                      ARRAY[]::text[]) AS subtasks
      FROM task_items t
      LEFT JOIN task_items c ON c.parent_id = t.id
      WHERE t.id = ${root.id} AND t.kind = 'task'
      GROUP BY t.id
    `;
    if (!row) return;
    await addDocs(env, TASKS_INDEX, [row]);
    await sql`UPDATE task_items SET search_indexed_at = CASE WHEN xmin::text = ${row.row_version}
      AND (SELECT COALESCE(string_agg(child.id::text || ':' || child.xmin::text, ',' ORDER BY child.id), '')
           FROM task_items child WHERE child.parent_id = ${root.id}) = ${row.child_versions}
      THEN now() ELSE NULL END WHERE id = ${root.id}`;
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'task_item_meili_sync_failed',
        task_item_id: taskId,
        message: /** @type {Error} */ (error).message,
      }),
    );
  }
}

/**
 * @param {any} env
 * @param {string} taskId
 * @param {{deleteDocuments?: Function}} [deps]
 */
export async function removeTaskItemFromMeili(env, taskId, deps = {}) {
  if (env?.deferSearchSync) {
    env.deferSearchSync(() =>
      removeTaskItemFromMeili({ ...env, deferSearchSync: undefined }, taskId, deps),
    );
    return;
  }
  if (!env || !meiliAvailable(env)) return;
  const removeDocs = deps.deleteDocuments ?? deleteDocumentsDefault;

  try {
    await removeDocs(env, TASKS_INDEX, [taskId]);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'task_item_meili_delete_failed',
        task_item_id: taskId,
        message: /** @type {Error} */ (error).message,
      }),
    );
  }
}
