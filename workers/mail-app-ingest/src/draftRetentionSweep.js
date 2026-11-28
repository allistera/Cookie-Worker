import { retryWithFreshClient } from '../../../shared/transient-db.js';
import { captureHandledException } from './sentry.js';

export const DRAFT_RETENTION_DAYS = 30;
// One tick's worth of deletions, so a backlog is spread over several ticks.
export const PURGE_LIMIT = 500;

/**
 * Deletes drafts that are not starred and have gone DRAFT_RETENTION_DAYS
 * without a save. The clock is the later of the last save and
 * drafts.retention_from (migration 0119), which gives a draft that predates
 * the rule, or has just lost its star, the full period again.
 *
 * Deletion is the same DELETE the Drafts view's Discard makes: the draft's
 * attachment rows cascade, and the draft cannot be restored.
 *
 * Errors are logged and swallowed: this runs under ctx.waitUntil on the
 * ingest cron alongside the other sweeps, and must never fail the tick. A
 * dropped Hyperdrive socket gets a fresh client and another go: rows already
 * deleted are gone, so a re-run is safe.
 *
 * @param {any} env
 * @param {{createSql?: (url: string) => any}} [deps]
 */
export async function purgeExpiredDrafts(env, deps = {}) {
  const makeSql = deps.createSql;
  if (!makeSql) {
    console.log(JSON.stringify({ event: 'draft_purge_misconfigured' }));
    return;
  }

  try {
    const rows = await retryWithFreshClient(
      () => makeSql(env.HYPERDRIVE.connectionString),
      (sql) => sql`
      WITH expired AS (
        SELECT id
        FROM drafts
        WHERE NOT is_starred
          AND GREATEST(updated_at, retention_from)
              < now() - make_interval(days => ${DRAFT_RETENTION_DAYS}::int)
        ORDER BY GREATEST(updated_at, retention_from)
        LIMIT ${PURGE_LIMIT}
      )
      DELETE FROM drafts d
      USING expired
      -- A star or a save can commit while this DELETE waits for the row, so
      -- the conditions are repeated on the row being deleted: PostgreSQL
      -- checks them again against its new version.
      WHERE d.id = expired.id
        AND NOT d.is_starred
        AND GREATEST(d.updated_at, d.retention_from)
            < now() - make_interval(days => ${DRAFT_RETENTION_DAYS}::int)
      RETURNING d.id
    `,
    );
    if (rows.length) {
      console.log(JSON.stringify({ event: 'drafts_purged', deleted: rows.length }));
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        event: 'draft_purge_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    captureHandledException('draft_purge', err, [env.HYPERDRIVE.connectionString]);
  }
}
