// The built-in jobs an automation can run. Each is fixed code with no model
// call: it answers with one sentence saying what the run did, which becomes
// the run's summary, and throws when the run could not do its work.

import { localDate } from './schedule.js';

/** A run that failed for a reason worth telling the person; the message is shown to them. */
export class RunError extends Error {}

/**
 * @typedef {{
 *   call(
 *     identity: {userId: string, email: string},
 *     call: {method: string, path: string, body?: unknown},
 *   ): Promise<{status: number, body: unknown}>,
 * }} InternalService
 * @typedef {{
 *   sql: import('postgres').Sql,
 *   tasks: InternalService,
 *   identity: {userId: string, email: string},
 *   timeZone: string,
 *   now: Date,
 * }} RunContext
 */

// How many tasks one run moves. Each move is a call to cookie-web-tasks, and
// an invocation has a fixed allowance of those; a longer backlog is finished
// by the following runs.
export const MAX_MOVES_PER_RUN = 100;

/** @param {number} count @param {string} noun */
function counted(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Moves every open task whose due date has passed to today, in the
 * automation's time zone. Only the date changes: a repeating task keeps its
 * schedule and a timed task keeps its time.
 *
 * Tasks mirrored from Todoist are left alone while that sync is on. Their
 * dates come from Todoist, so a date changed here would be put back by the
 * next sync.
 *
 * @param {RunContext} context
 * @returns {Promise<string>}
 */
async function rescheduleOverdue({ sql, tasks, identity, timeZone, now }) {
  const today = localDate(timeZone, now);
  const overdue = await sql`
    SELECT t.id,
           (t.todoist_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM todoist_connections c
              WHERE c.user_id = t.user_id AND c.sync_tasks)) AS mirrored
    FROM task_items t
    WHERE t.user_id = ${identity.userId} AND t.kind = 'task' AND t.completed_at IS NULL
      AND t.due_date < ${today}::date
    ORDER BY t.due_date, t.position
    LIMIT 1000
  `;
  const mirrored = overdue.filter((task) => task.mirrored).length;
  const own = overdue.filter((task) => !task.mirrored);
  let moved = 0;
  let failed = 0;
  for (const task of own.slice(0, MAX_MOVES_PER_RUN)) {
    const { status } = await tasks.call(identity, {
      method: 'PATCH',
      path: '/task-items',
      body: { id: task.id, dueDate: today },
    });
    if (status >= 200 && status < 300) moved += 1;
    // 404 and 409: the task was deleted or changed while the run was under
    // way, which is the person's own doing rather than a failure.
    else if (status !== 404 && status !== 409) failed += 1;
  }
  const notes = [];
  if (own.length > MAX_MOVES_PER_RUN) {
    notes.push(
      `${counted(own.length - MAX_MOVES_PER_RUN, 'more task')} will move on the next run.`,
    );
  }
  if (mirrored) {
    notes.push(
      `Left ${counted(mirrored, 'Todoist task')} as ${mirrored === 1 ? 'it is' : 'they are'}.`,
    );
  }
  if (failed) {
    throw new RunError(
      [`Moved ${counted(moved, 'task')} to today; ${failed} could not be moved.`, ...notes].join(
        ' ',
      ),
    );
  }
  const lead = moved ? `Moved ${counted(moved, 'overdue task')} to today.` : 'Nothing was overdue.';
  return [lead, ...notes].join(' ');
}

/** @type {Record<string, {name: string, run: (context: RunContext) => Promise<string>}>} */
export const HANDLERS = {
  reschedule_overdue: { name: 'Reschedule Overdue Tasks to Today', run: rescheduleOverdue },
};
