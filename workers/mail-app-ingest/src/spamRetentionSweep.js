import { retryWithFreshClient } from '../../../shared/transient-db.js';
import { captureHandledException } from './sentry.js';

// One tick's worth of deletions. Retention is measured in days, so a tick
// normally finds a handful of rows at most; the bound only matters the first
// time the sweep runs against a long-standing backlog, or when someone drops
// their retention from a year to a week, and spreads that over several ticks.
export const PURGE_LIMIT = 500;
export const DEFAULT_SPAM_RETENTION_DAYS = 30;

/**
 * Soft-deletes spam that has sat in the Spam folder longer than its owner's
 * retention. Only what the folder lists is eligible (folderPredicate('spam')
 * in cookie-web-emails): spam the user moved to Done is theirs to keep. (users.prefs.spamRetentionDays, 30 by default, bounded to 1–365
 * here as well as at the API so a hand-edited value cannot wipe or pin a
 * mailbox). The clock starts when the verdict landed — message_ai.processed_at,
 * set by both the classifier and a user's own report — so a message reported
 * long after it arrived still gets its full retention. Deletion is the same
 * is_deleted flag the reader's Delete uses, and search_indexed_at is cleared
 * in the same statement so the drift sweep drops the rows from Meilisearch.
 *
 * Errors are logged and swallowed: this runs under ctx.waitUntil on the
 * ingest cron alongside the other sweeps, and must never fail the tick. A
 * dropped Hyperdrive socket (Sentry COOKIE-WEB-12) gets a fresh client and
 * another go first: rows already deleted are excluded, so a re-run is safe.
 *
 * @param {any} env
 * @param {{createSql?: (url: string) => any}} [deps]
 */
export async function purgeExpiredSpam(env, deps = {}) {
  const makeSql = deps.createSql;
  if (!makeSql) {
    console.log(JSON.stringify({ event: 'spam_purge_misconfigured' }));
    return;
  }

  try {
    const rows = await retryWithFreshClient(
      () => makeSql(env.HYPERDRIVE.connectionString),
      (sql) => sql`
      WITH expired AS (
        SELECT m.id
        FROM message_ai ai
        JOIN messages m ON m.id = ai.message_id
        JOIN users u ON u.id = m.user_id
        WHERE ai.spam_verdict = 'spam'
          AND m.screening_status = 'allowed'
          AND NOT m.is_deleted AND NOT m.is_archived AND NOT m.is_sent
          AND COALESCE(ai.processed_at, m.created_at) < now() - make_interval(
            days => LEAST(365, GREATEST(1,
              CASE WHEN jsonb_typeof(u.prefs -> 'spamRetentionDays') = 'number'
                   THEN floor((u.prefs ->> 'spamRetentionDays')::numeric)::int
                   ELSE ${DEFAULT_SPAM_RETENTION_DAYS}::int
              END
            ))
          )
        ORDER BY COALESCE(ai.processed_at, m.created_at)
        LIMIT ${PURGE_LIMIT}
      )
      UPDATE messages m
      SET is_deleted = true, search_indexed_at = NULL
      FROM expired
      WHERE m.id = expired.id
      RETURNING m.id
    `,
    );
    if (rows.length) {
      console.log(JSON.stringify({ event: 'spam_purged', deleted: rows.length }));
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        event: 'spam_purge_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    captureHandledException('spam_purge', err, [env.HYPERDRIVE.connectionString]);
  }
}
