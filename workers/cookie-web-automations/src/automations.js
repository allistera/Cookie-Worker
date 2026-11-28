// The Automations app's API: the person's automations, and what they did.
//
//   GET    /automations        the caller's automations
//   POST   /automations        { handler, trigger, name? }
//   PATCH  /automations        { id, name?, enabled?, trigger? }
//   DELETE /automations        { id }
//   POST   /automations/run    { id } — run it now and answer with the run
//   GET    /automation-runs    the caller's latest runs, newest first

import { HANDLERS } from './handlers.js';
import { executeRun } from './runner.js';
import { nextRunAt, normalizeTrigger, TriggerError } from './schedule.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 120;
// Far more than the built-in jobs give a use for; it keeps one account from
// filling every cron tick.
const MAX_AUTOMATIONS = 20;
const MAX_RUNS_LISTED = 30;

/** @param {string} message @param {number} [status] */
function refuse(message, status = 400) {
  return Response.json({ error: message }, { status });
}

/** @param {unknown} value */
function cleanName(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_NAME_LENGTH) : '';
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export async function listAutomations(sql, userId) {
  const automations = await sql`
    SELECT id, name, handler, trigger, enabled, next_run_at AS "nextRunAt",
           created_at AS "createdAt"
    FROM automations
    WHERE user_id = ${userId}
    ORDER BY created_at, id
  `;
  return Response.json({ automations }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {Date} now
 */
export async function createAutomation(sql, userId, body, now) {
  const handler = typeof body?.handler === 'string' ? body.handler : '';
  if (!Object.hasOwn(HANDLERS, handler)) return refuse('handler is not a known automation');
  let trigger;
  try {
    trigger = normalizeTrigger(body.trigger);
  } catch (error) {
    if (error instanceof TriggerError) return refuse(error.message);
    throw error;
  }
  if (Object.hasOwn(body, 'name') && !cleanName(body.name)) return refuse('name cannot be empty');
  const name = cleanName(body.name) || HANDLERS[handler].name;
  const [{ count }] = await sql`
    SELECT count(*)::int AS count FROM automations WHERE user_id = ${userId}
  `;
  if (count >= MAX_AUTOMATIONS) {
    return refuse(`An account can have ${MAX_AUTOMATIONS} automations`, 409);
  }
  const [automation] = await sql`
    INSERT INTO automations (user_id, name, handler, trigger, next_run_at)
    VALUES (${userId}, ${name}, ${handler}, ${sql.json(trigger)}, ${nextRunAt(trigger, now)})
    RETURNING id, name, handler, trigger, enabled, next_run_at AS "nextRunAt",
              created_at AS "createdAt"
  `;
  return Response.json({ automation }, { status: 201 });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {Date} now
 */
export async function updateAutomation(sql, userId, body, now) {
  const id = typeof body?.id === 'string' && UUID.test(body.id) ? body.id : null;
  if (!id) return refuse('A valid automation id is required');
  const hasName = Object.hasOwn(body, 'name');
  const hasEnabled = Object.hasOwn(body, 'enabled');
  const hasTrigger = Object.hasOwn(body, 'trigger');
  if (!hasName && !hasEnabled && !hasTrigger) return refuse('At least one change is required');
  if (hasName && !cleanName(body.name)) return refuse('name cannot be empty');
  if (hasEnabled && typeof body.enabled !== 'boolean') return refuse('enabled must be a boolean');

  const [existing] = await sql`
    SELECT trigger, enabled FROM automations WHERE id = ${id} AND user_id = ${userId}
  `;
  if (!existing) return refuse('Automation not found', 404);
  let trigger;
  try {
    // The stored schedule is read again when it is only being switched on,
    // so one this code can no longer read is refused rather than left due.
    trigger = normalizeTrigger(hasTrigger ? body.trigger : existing.trigger);
  } catch (error) {
    if (error instanceof TriggerError) return refuse(error.message);
    throw error;
  }
  const enabled = hasEnabled ? body.enabled : Boolean(existing.enabled);
  // Worked out afresh on every save: switching an automation back on, or
  // changing its time, must never leave a time in the past that the next
  // tick would run at once.
  const next = enabled ? nextRunAt(trigger, now) : null;
  const [automation] = await sql`
    UPDATE automations SET
      name = CASE WHEN ${hasName}::boolean THEN ${cleanName(body.name)} ELSE name END,
      trigger = ${sql.json(trigger)},
      enabled = ${enabled},
      next_run_at = ${next},
      updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id, name, handler, trigger, enabled, next_run_at AS "nextRunAt",
              created_at AS "createdAt"
  `;
  if (!automation) return refuse('Automation not found', 404);
  return Response.json({ automation });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {any} body */
export async function deleteAutomation(sql, userId, body) {
  const id = typeof body?.id === 'string' && UUID.test(body.id) ? body.id : null;
  if (!id) return refuse('A valid automation id is required');
  const deleted = await sql`
    DELETE FROM automations WHERE id = ${id} AND user_id = ${userId} RETURNING id
  `;
  if (!deleted.length) return refuse('Automation not found', 404);
  return new Response(null, { status: 204 });
}

/**
 * Runs one automation now, whether or not it is switched on, and answers
 * once it has finished. Its schedule is left as it was.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {import('./runner.js').RunnerEnv} env
 * @param {Date} now
 * @param {import('./runner.js').Report} report
 */
export async function runAutomationNow(sql, userId, body, env, now, report) {
  const id = typeof body?.id === 'string' && UUID.test(body.id) ? body.id : null;
  if (!id) return refuse('A valid automation id is required');
  const [automation] = await sql`
    SELECT a.id, a.name, a.user_id AS "userId", lower(u.email) AS email, a.handler, a.trigger
    FROM automations a JOIN users u ON u.id = a.user_id
    WHERE a.id = ${id} AND a.user_id = ${userId}
  `;
  if (!automation) return refuse('Automation not found', 404);
  const [run] = await sql`
    INSERT INTO automation_runs (automation_id, user_id, trigger)
    VALUES (${id}, ${userId}, 'manual')
    RETURNING id, started_at AS "startedAt"
  `;
  const outcome = await executeRun(
    sql,
    env,
    /** @type {import('./runner.js').RunnableAutomation} */ (/** @type {unknown} */ (automation)),
    String(run.id),
    now,
    report,
  );
  return Response.json({
    run: {
      id: run.id,
      automationId: id,
      automationName: automation.name,
      trigger: 'manual',
      startedAt: run.startedAt,
      ...outcome,
    },
  });
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export async function listRuns(sql, userId) {
  const runs = await sql`
    SELECT r.id, r.automation_id AS "automationId", a.name AS "automationName", r.trigger,
           r.status, r.summary, r.started_at AS "startedAt", r.finished_at AS "finishedAt"
    FROM automation_runs r JOIN automations a ON a.id = r.automation_id
    WHERE r.user_id = ${userId}
    ORDER BY r.started_at DESC, r.id
    LIMIT ${MAX_RUNS_LISTED}
  `;
  return Response.json({ runs }, { headers: { 'Cache-Control': 'no-store' } });
}
