// Runs automations: the ones whose schedule has come due (the cron tick) and
// one the person asked to run now.
//
// A due automation is claimed in one transaction that moves its next_run_at
// on and writes its run as 'running', then run after that transaction has
// committed. So a scheduled time is run at most once, by whichever tick
// claims it; a run whose invocation died stays 'running' until a later tick
// marks it failed.

import { HANDLERS, RunError } from './handlers.js';
import { nextRunAt, normalizeTrigger } from './schedule.js';

// How many automations one tick runs, oldest due first; the rest wait for
// the next tick.
const MAX_RUNS_PER_TICK = 10;
const MAX_SUMMARY_LENGTH = 500;

/**
 * @typedef {{TASKS: import('./handlers.js').InternalService}} RunnerEnv
 * @typedef {{
 *   id: string, userId: string, email: string, handler: string, trigger: unknown,
 * }} RunnableAutomation
 * @typedef {(operation: string, error: unknown, extra?: Record<string, unknown>) => void} Report
 */

/**
 * Runs one claimed automation and settles its run row. Never throws: a
 * failure becomes the run's outcome.
 *
 * @param {import('postgres').Sql} sql
 * @param {RunnerEnv} env
 * @param {RunnableAutomation} automation
 * @param {string} runId
 * @param {Date} now
 * @param {Report} report
 * @returns {Promise<{status: 'succeeded' | 'failed', summary: string}>}
 */
export async function executeRun(sql, env, automation, runId, now, report) {
  /** @type {{status: 'succeeded' | 'failed', summary: string}} */
  let outcome;
  try {
    const handler = Object.hasOwn(HANDLERS, automation.handler)
      ? HANDLERS[automation.handler]
      : null;
    if (!handler) throw new RunError('This automation is no longer available.');
    const summary = await handler.run({
      sql,
      tasks: env.TASKS,
      identity: { userId: automation.userId, email: automation.email },
      timeZone: normalizeTrigger(automation.trigger).timeZone,
      now,
    });
    outcome = { status: 'succeeded', summary };
  } catch (error) {
    if (!(error instanceof RunError)) report('run', error, { handler: automation.handler });
    outcome = {
      status: 'failed',
      summary: error instanceof RunError ? error.message : 'The run failed.',
    };
  }
  outcome.summary = outcome.summary.slice(0, MAX_SUMMARY_LENGTH);
  await sql`
    UPDATE automation_runs
    SET status = ${outcome.status}, summary = ${outcome.summary}, finished_at = now()
    WHERE id = ${runId}
  `;
  console.log(
    JSON.stringify({
      event: 'automation_run',
      handler: automation.handler,
      status: outcome.status,
    }),
  );
  return outcome;
}

/**
 * The cron tick: settles runs that never finished, then claims and runs
 * every automation that has come due.
 *
 * @param {import('postgres').Sql} sql
 * @param {RunnerEnv} env
 * @param {Date} now
 * @param {Report} report
 * @returns {Promise<number>} How many automations ran.
 */
export async function runDueAutomations(sql, env, now, report) {
  await sql`
    UPDATE automation_runs
    SET status = 'failed', summary = 'The run did not finish.', finished_at = now()
    WHERE status = 'running' AND started_at < now() - interval '15 minutes'
  `;
  /** @type {{automation: RunnableAutomation, runId: string}[]} */
  const claimed = await sql.begin(async (tx) => {
    const due = await tx`
      SELECT a.id, a.user_id AS "userId", lower(u.email) AS email, a.handler, a.trigger
      FROM automations a JOIN users u ON u.id = a.user_id
      WHERE a.enabled AND a.next_run_at <= ${now}
      ORDER BY a.next_run_at
      LIMIT ${MAX_RUNS_PER_TICK}
      FOR UPDATE OF a SKIP LOCKED
    `;
    const runs = [];
    for (const row of due) {
      const automation = /** @type {RunnableAutomation} */ (/** @type {unknown} */ (row));
      /** @type {Date | null} */
      let next = null;
      try {
        next = nextRunAt(normalizeTrigger(automation.trigger), now);
      } catch (error) {
        // A stored schedule this code cannot read would otherwise come due
        // on every tick. The run below fails and says so.
        report('schedule', error, { handler: automation.handler });
      }
      await tx`
        UPDATE automations
        SET next_run_at = ${next}, enabled = ${next !== null}, updated_at = now()
        WHERE id = ${automation.id}
      `;
      const [run] = await tx`
        INSERT INTO automation_runs (automation_id, user_id, trigger)
        VALUES (${automation.id}, ${automation.userId}, 'schedule')
        RETURNING id
      `;
      runs.push({ automation, runId: String(run.id) });
    }
    return runs;
  });
  for (const { automation, runId } of claimed) {
    await executeRun(sql, env, automation, runId, now, report);
  }
  return claimed.length;
}
