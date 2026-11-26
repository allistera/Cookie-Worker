// Cookie to Todoist: the one thing the Todoist sync writes back. A mirrored
// task completed in Cookie is closed in Todoist, and one marked not done
// again is reopened there. Everything else about a mirror still comes from
// Todoist (todoistSync.js).
//
// A PATCH that changes a mirror's completion records what Todoist has yet to
// be told in task_items.todoist_pending (migration 0116), in the same
// statement as the change. That is then sent twice over:
//
// - straight away, once the change has committed, on the request's deferred
//   queue (pushTaskCompletion), so Todoist agrees within a second or so;
// - by every sync, before it reads Todoist (pushPendingCompletions), which
//   is what delivers a change the first attempt could not: Todoist was down,
//   or the connection had its tasks switched off at the time.
//
// The column is cleared only once Todoist has answered, so a change is never
// dropped for a failure worth another go; a sync leaves a row that still
// carries one as Cookie has it rather than taking Todoist's older word. The
// price is that an attempt whose answer was lost is sent again, which a
// repeating task feels as one occurrence skipped.

import { decryptToken } from '../../../shared/token-crypto.js';
import { setTaskCompletion } from './todoistApi.js';

// How many changes one call sends. A sync shares its invocation's
// subrequest allowance with the reads that follow, and a backlog (tasks
// switched back on after a week of ticking) drains over a few runs instead.
export const MAX_PUSHES_PER_RUN = 20;

/**
 * Sends the caller's pending completions to Todoist, oldest first, and
 * clears each one Todoist answered — taken or refused for good (the task is
 * gone there; the next sync settles what that means here). A rejected token
 * or a failure worth another go throws, leaving that row and the ones after
 * it pending.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} token
 * @param {{taskId?: string | null, fetchImpl?: typeof fetch}} [options]
 *   `taskId` narrows the call to one Cookie task.
 * @returns {Promise<number>} How many changes Todoist took.
 */
export async function pushPendingCompletions(sql, userId, token, options = {}) {
  const taskId = options.taskId ?? null;
  // The push after a PATCH and the push at the start of a sync can overlap.
  // Both would read the same pending row and send it, and Todoist advances a
  // repeating task once per close. A per-user lock held for the whole read,
  // send and clear makes the second wait and then read what the first left
  // pending (seed 2: not the task lock, seed 1, that a sync applies under).
  // The failure that stops a run is rethrown only after the clears
  // of the changes Todoist did take have committed.
  /** @type {unknown} */
  let failure = null;
  const pushed = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 2))`;
    const rows = await tx`
      SELECT id, todoist_id AS "todoistId", todoist_pending AS action
      FROM task_items
      WHERE user_id = ${userId} AND todoist_pending IS NOT NULL AND todoist_id IS NOT NULL
        AND (${taskId}::uuid IS NULL OR id = ${taskId}::uuid)
      ORDER BY updated_at
      LIMIT ${MAX_PUSHES_PER_RUN}
    `;
    let count = 0;
    for (const row of rows) {
      let taken;
      try {
        taken = await setTaskCompletion(
          token,
          String(row.todoistId),
          row.action,
          options.fetchImpl,
        );
      } catch (error) {
        failure = error;
        break;
      }
      if (taken) count += 1;
      else console.log(JSON.stringify({ event: 'todoist_push_refused', action: row.action }));
      // Only the change that was sent: one made meanwhile stays pending.
      await tx`
        UPDATE task_items SET todoist_pending = NULL
        WHERE user_id = ${userId} AND id = ${row.id} AND todoist_pending = ${row.action}
      `;
    }
    return count;
  });
  if (failure) throw failure;
  return pushed;
}

/**
 * The attempt made straight after a task's completion changed: sends that
 * one task's pending change when the caller has a Todoist connection with
 * tasks switched on. Never throws — whatever it could not send stays
 * pending for the next sync.
 *
 * @param {import('postgres').Sql} sql
 * @param {{TODOIST_TOKEN_ENCRYPTION_KEY?: string}} env
 * @param {string} userId
 * @param {string} taskId
 * @param {{fetchImpl?: typeof fetch}} [deps]
 */
export async function pushTaskCompletion(sql, env, userId, taskId, deps = {}) {
  if (!env?.TODOIST_TOKEN_ENCRYPTION_KEY) return;
  try {
    const [connection] = await sql`
      SELECT api_token_encrypted AS "apiTokenEncrypted", sync_tasks AS "syncTasks"
      FROM todoist_connections
      WHERE user_id = ${userId}
    `;
    if (!connection || connection.syncTasks === false) return;
    const token = await decryptToken(
      String(connection.apiTokenEncrypted),
      env.TODOIST_TOKEN_ENCRYPTION_KEY,
    );
    await pushPendingCompletions(sql, userId, token, { taskId, fetchImpl: deps.fetchImpl });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'todoist_push_failed',
        status: /** @type {{status?: number}} */ (error)?.status ?? null,
        reason: /** @type {Error} */ (error)?.name ?? 'Error',
      }),
    );
  }
}
