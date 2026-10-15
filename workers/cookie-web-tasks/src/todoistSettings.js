// Settings → Tasks → Todoist: the connection a person keeps with their
// Todoist account, and the two ways a sync is started.
//
//   GET    /tasks/todoist       what Settings shows: connected or not, the
//                               account's email, whether the hourly sync is
//                               on, and how the last run went.
//   PUT    /tasks/todoist       { token?, enabled? } — a token is checked
//                               against Todoist (GET /user) before it is
//                               stored encrypted; enabled flips the schedule.
//   DELETE /tasks/todoist       forgets the token. Mirrored projects and tasks
//                               stay, still linked, so reconnecting the same
//                               account picks them up in place.
//   POST   /tasks/todoist/sync  runs a sync now and answers with the result.
//
// The token is encrypted at rest under TODOIST_TOKEN_ENCRYPTION_KEY
// (shared/token-crypto.js); without that secret the feature reports itself
// as not configured and nothing is stored. The browser only ever sees the
// token's last four characters.
//
// The hourly cron (worker.js `scheduled`) runs runScheduledTodoistSyncs,
// which syncs every enabled connection whose local clock reads 07:00–20:00.

import { createSql, endSql } from '../../../shared/db.js';
import { allowRequest } from '../../../shared/rate-limit.js';
import { decryptToken, encryptToken } from '../../../shared/token-crypto.js';
import { captureHandledException } from './sentry.js';
import { TodoistApiError, TodoistAuthError, fetchAccount } from './todoistApi.js';
import {
  DEFAULT_TIME_ZONE,
  TOKEN_REJECTED_MESSAGE,
  describeSyncFailure,
  isSyncHour,
  recordSyncResult,
  syncConnection,
} from './todoistSync.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
// A run reads the whole account from Todoist; a held-down button should not
// be able to do that more than a few times a minute.
export const SYNC_RATE_LIMIT = { limit: 4, windowMs: 60_000 };
const MAX_TOKEN_LENGTH = 200;
const TOKEN_HINT_LENGTH = 4;
const TOKEN_UNREADABLE_MESSAGE = 'The saved token could not be read. Enter it again.';

/** @typedef {import('./sentry.js').TasksEnv & {deferSearchSync?: Function}} TodoistEnv */

/**
 * @typedef {{
 *   userId: string, apiTokenEncrypted: string, tokenHint: string, email: string | null,
 *   timeZone: string | null, enabled: boolean, lastSyncedAt: Date | null,
 *   lastSyncStatus: 'ok' | 'failed' | null, lastSyncError: string | null,
 *   lastSyncSummary: Record<string, number> | null,
 * }} TodoistConnection
 */

/** @param {{TODOIST_TOKEN_ENCRYPTION_KEY?: string}} env */
export function isTodoistConfigured(env) {
  return Boolean(env.TODOIST_TOKEN_ENCRYPTION_KEY);
}

/** @param {any} row @returns {TodoistConnection} */
function connectionFromRow(row) {
  return {
    userId: String(row.userId),
    apiTokenEncrypted: String(row.apiTokenEncrypted),
    tokenHint: String(row.tokenHint ?? ''),
    email: row.email ?? null,
    timeZone: row.timeZone ?? null,
    enabled: row.enabled === true,
    lastSyncedAt: row.lastSyncedAt ? new Date(row.lastSyncedAt) : null,
    lastSyncStatus: row.lastSyncStatus ?? null,
    lastSyncError: row.lastSyncError ?? null,
    lastSyncSummary:
      row.lastSyncSummary && typeof row.lastSyncSummary === 'object' ? row.lastSyncSummary : null,
  };
}

// The same column list in every read, aliased to the connection's fields;
// written out each time because postgres.js parameters cannot carry it.

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @returns {Promise<TodoistConnection | null>}
 */
export async function loadConnection(sql, userId) {
  const [row] = await sql`
    SELECT user_id AS "userId", api_token_encrypted AS "apiTokenEncrypted", token_hint AS "tokenHint",
           todoist_email AS email, time_zone AS "timeZone", enabled,
           last_synced_at AS "lastSyncedAt", last_sync_status AS "lastSyncStatus",
           last_sync_error AS "lastSyncError", last_sync_summary AS "lastSyncSummary"
    FROM todoist_connections
    WHERE user_id = ${userId}
  `;
  return row ? connectionFromRow(row) : null;
}

/**
 * A missing table (migration 0093 not applied yet) reads as "not connected"
 * so Settings keeps rendering through the rollout.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
async function loadConnectionIfAvailable(sql, userId) {
  try {
    return await loadConnection(sql, userId);
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code === '42P01') return null;
    throw error;
  }
}

/**
 * The wire shape Settings renders.
 *
 * @param {{TODOIST_TOKEN_ENCRYPTION_KEY?: string}} env
 * @param {TodoistConnection | null} connection
 */
export function publicSettings(env, connection) {
  return {
    configured: isTodoistConfigured(env),
    connected: Boolean(connection),
    enabled: connection?.enabled ?? false,
    email: connection?.email ?? null,
    tokenHint: connection?.tokenHint ?? '',
    timeZone: connection?.timeZone ?? null,
    lastSyncedAt: connection?.lastSyncedAt ? connection.lastSyncedAt.toISOString() : null,
    lastSyncStatus: connection?.lastSyncStatus ?? null,
    lastSyncError: connection?.lastSyncError ?? null,
    lastSyncSummary: connection?.lastSyncSummary ?? null,
  };
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {TodoistEnv} env
 */
export async function getTodoistSettings(sql, userId, env) {
  const connection = await loadConnectionIfAvailable(sql, userId);
  return Response.json({ todoist: publicSettings(env, connection) }, { headers: NO_STORE });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {TodoistEnv} env
 * @param {{fetchImpl?: typeof fetch}} [deps]
 */
export async function putTodoistSettings(sql, userId, body, env, deps = {}) {
  if (!isTodoistConfigured(env)) {
    return Response.json(
      { error: 'Todoist sync is not configured for this deployment' },
      { status: 501 },
    );
  }
  const hasToken = Object.hasOwn(body ?? {}, 'token');
  const hasEnabled = Object.hasOwn(body ?? {}, 'enabled');
  if (!hasToken && !hasEnabled) {
    return Response.json({ error: 'A token or an enabled flag is required' }, { status: 400 });
  }
  if (hasEnabled && typeof body.enabled !== 'boolean') {
    return Response.json({ error: 'enabled must be true or false' }, { status: 400 });
  }
  const enabled = hasEnabled ? Boolean(body.enabled) : null;

  if (!hasToken) {
    const [row] = await sql`
      UPDATE todoist_connections SET enabled = ${enabled}, updated_at = now()
      WHERE user_id = ${userId}
      RETURNING user_id AS "userId", api_token_encrypted AS "apiTokenEncrypted", token_hint AS "tokenHint",
                todoist_email AS email, time_zone AS "timeZone", enabled,
                last_synced_at AS "lastSyncedAt", last_sync_status AS "lastSyncStatus",
                last_sync_error AS "lastSyncError", last_sync_summary AS "lastSyncSummary"
    `;
    if (!row) return Response.json({ error: 'Connect Todoist first' }, { status: 404 });
    return Response.json(
      { todoist: publicSettings(env, connectionFromRow(row)) },
      { headers: NO_STORE },
    );
  }

  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    return Response.json({ error: 'That does not look like a Todoist API token' }, { status: 400 });
  }
  let account;
  try {
    account = await fetchAccount(token, deps.fetchImpl);
  } catch (error) {
    if (error instanceof TodoistAuthError) {
      return Response.json({ error: 'Todoist rejected that token' }, { status: 400 });
    }
    console.log(
      JSON.stringify({
        event: 'todoist_account_check_failed',
        status: /** @type {{status?: number}} */ (error)?.status ?? null,
      }),
    );
    return Response.json({ error: 'Could not reach Todoist. Try again.' }, { status: 502 });
  }

  const key = /** @type {string} */ (env.TODOIST_TOKEN_ENCRYPTION_KEY);
  const encrypted = await encryptToken(token, key);
  const [row] = await sql`
    INSERT INTO todoist_connections
      (user_id, api_token_encrypted, token_hint, todoist_email, time_zone, enabled)
    SELECT ${userId}, ${encrypted}, ${token.slice(-TOKEN_HINT_LENGTH)}, ${account.email},
           ${account.timeZone}, ${enabled ?? true}
    WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId})
    ON CONFLICT (user_id) DO UPDATE SET
      api_token_encrypted = EXCLUDED.api_token_encrypted,
      token_hint          = EXCLUDED.token_hint,
      todoist_email       = EXCLUDED.todoist_email,
      time_zone           = EXCLUDED.time_zone,
      enabled             = CASE WHEN ${hasEnabled}::boolean THEN EXCLUDED.enabled
                                 ELSE todoist_connections.enabled END,
      -- A new token clears the verdict on the old one.
      last_sync_status    = NULL,
      last_sync_error     = NULL,
      updated_at          = now()
    RETURNING user_id AS "userId", api_token_encrypted AS "apiTokenEncrypted", token_hint AS "tokenHint",
              todoist_email AS email, time_zone AS "timeZone", enabled,
              last_synced_at AS "lastSyncedAt", last_sync_status AS "lastSyncStatus",
              last_sync_error AS "lastSyncError", last_sync_summary AS "lastSyncSummary"
  `;
  if (!row) return Response.json({ error: 'User not found' }, { status: 404 });
  return Response.json(
    { todoist: publicSettings(env, connectionFromRow(row)) },
    { headers: NO_STORE },
  );
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function deleteTodoistSettings(sql, userId) {
  const deleted = await sql`
    DELETE FROM todoist_connections WHERE user_id = ${userId} RETURNING user_id
  `;
  if (!deleted.length) return Response.json({ error: 'Todoist is not connected' }, { status: 404 });
  return Response.json({ ok: true });
}

/**
 * POST /tasks/todoist/sync — a run now, answered with the updated settings
 * (whose summary and status describe this run).
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {TodoistEnv} env
 * @param {{fetchImpl?: typeof fetch, now?: () => Date}} [deps]
 */
export async function postTodoistSync(sql, userId, env, deps = {}) {
  if (!isTodoistConfigured(env)) {
    return Response.json(
      { error: 'Todoist sync is not configured for this deployment' },
      { status: 501 },
    );
  }
  let allowed;
  try {
    allowed = await allowRequest(sql, userId, 'todoist-sync', SYNC_RATE_LIMIT);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'todoist_sync_quota_failed',
        message: /** @type {Error} */ (error).message,
      }),
    );
    return Response.json({ error: 'Sync is temporarily unavailable' }, { status: 503 });
  }
  if (!allowed) {
    return Response.json({ error: 'Too many syncs. Try again shortly.' }, { status: 429 });
  }

  const connection = await loadConnection(sql, userId);
  if (!connection) return Response.json({ error: 'Connect Todoist first' }, { status: 404 });

  let token;
  try {
    token = await decryptToken(
      connection.apiTokenEncrypted,
      /** @type {string} */ (env.TODOIST_TOKEN_ENCRYPTION_KEY),
    );
  } catch {
    await recordSyncResult(sql, userId, { status: 'failed', error: TOKEN_UNREADABLE_MESSAGE });
    return Response.json({ error: TOKEN_UNREADABLE_MESSAGE }, { status: 409 });
  }

  try {
    await syncConnection(sql, env, { ...connection, token }, deps);
  } catch (error) {
    if (error instanceof TodoistAuthError) {
      return Response.json({ error: TOKEN_REJECTED_MESSAGE }, { status: 409 });
    }
    if (error instanceof TodoistApiError || /** @type {Error} */ (error)?.name === 'AbortError') {
      return Response.json({ error: describeSyncFailure(error) }, { status: 502 });
    }
    throw error;
  }
  const updated = await loadConnection(sql, userId);
  return Response.json({ todoist: publicSettings(env, updated) }, { headers: NO_STORE });
}

/**
 * The hourly cron's work: every enabled connection whose local hour is in
 * the window, each on its own terms — one account's failure (a revoked
 * token, a Todoist outage) is recorded on that connection and reported, and
 * the next account still runs.
 *
 * @param {TodoistEnv} env
 * @param {Date} scheduledAt
 * @param {{fetchImpl?: typeof fetch}} [deps]
 * @returns {Promise<{ran: number, failed: number, skipped: number}>}
 */
export async function runScheduledTodoistSyncs(env, scheduledAt, deps = {}) {
  const result = { ran: 0, failed: 0, skipped: 0 };
  if (!isTodoistConfigured(env)) {
    console.log(JSON.stringify({ event: 'todoist_schedule_skipped', reason: 'not configured' }));
    return result;
  }
  const key = /** @type {string} */ (env.TODOIST_TOKEN_ENCRYPTION_KEY);
  const sql = createSql(env.HYPERDRIVE.connectionString);
  try {
    const rows = await sql`
      SELECT user_id AS "userId", api_token_encrypted AS "apiTokenEncrypted", token_hint AS "tokenHint",
             todoist_email AS email, time_zone AS "timeZone", enabled,
             last_synced_at AS "lastSyncedAt", last_sync_status AS "lastSyncStatus",
             last_sync_error AS "lastSyncError", last_sync_summary AS "lastSyncSummary"
      FROM todoist_connections
      WHERE enabled
      ORDER BY user_id
    `;
    for (const row of rows) {
      const connection = connectionFromRow(row);
      if (!isSyncHour(scheduledAt, connection.timeZone ?? DEFAULT_TIME_ZONE)) {
        result.skipped += 1;
        continue;
      }
      let token;
      try {
        token = await decryptToken(connection.apiTokenEncrypted, key);
      } catch (error) {
        result.failed += 1;
        await recordSyncResult(sql, connection.userId, {
          status: 'failed',
          error: TOKEN_UNREADABLE_MESSAGE,
        }).catch(() => undefined);
        captureHandledException('todoist_token_decrypt', error, env);
        continue;
      }
      try {
        await syncConnection(sql, env, { ...connection, token }, deps);
        result.ran += 1;
      } catch (error) {
        result.failed += 1;
        // A rejected token is the account's own state, already recorded on
        // the row for Settings to show; it is not an incident.
        if (!(error instanceof TodoistAuthError)) {
          captureHandledException('todoist_scheduled_sync', error, env);
        }
      }
    }
  } finally {
    await endSql(sql);
  }
  console.log(JSON.stringify({ event: 'todoist_schedule_ran', ...result }));
  return result;
}
