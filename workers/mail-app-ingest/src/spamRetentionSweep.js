import { retryWithFreshClient } from '../../../shared/transient-db.js';
import { captureHandledException } from './sentry.js';

// One tick's worth of deletions, spam and blocked mail together. Retention is
// measured in days, so a tick normally finds a handful of rows at most; the
// bound only matters the first time the sweep runs against a long-standing
// backlog, or when someone drops their retention from a year to a week, and
// spreads that over several ticks.
export const PURGE_LIMIT = 500;
export const DEFAULT_SPAM_RETENTION_DAYS = 30;

/**
 * Soft-deletes spam and blocked mail that has sat in its folder longer than
 * the owner's retention (users.prefs.spamRetentionDays, 30 by default, bounded
 * to 1–365 here as well as at the API so a hand-edited value cannot wipe or
 * pin a mailbox). Only what the two folders list is eligible
 * (folderPredicate in cookie-web-emails): spam the user moved to Done is
 * theirs to keep, and mail held in New senders waits for a decision however
 * long that takes.
 *
 * Each clock starts when the mail landed in its folder, so nothing is deleted
 * the moment it gets there. For spam that is when the verdict landed
 * (message_ai.processed_at, set by both the classifier and a user's own
 * report). For blocked mail it is the later of its arrival and the sender
 * decision that covers it: mail from an already-blocked sender counts from
 * arrival, and mail that moved into Blocked when the sender was blocked counts
 * from that decision.
 *
 * Deletion is the same is_deleted flag the reader's Delete uses, and
 * search_indexed_at is cleared in the same statement so the drift sweep drops
 * the rows from Meilisearch.
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
      WITH retention AS (
        SELECT u.id AS user_id, now() - make_interval(
          days => LEAST(365, GREATEST(1,
            CASE WHEN jsonb_typeof(u.prefs -> 'spamRetentionDays') = 'number'
                 THEN floor((u.prefs ->> 'spamRetentionDays')::numeric)::int
                 ELSE ${DEFAULT_SPAM_RETENTION_DAYS}::int
            END
          ))
        ) AS cutoff
        FROM users u
      ),
      expired AS (
        (
          SELECT m.id, m.screening_status, COALESCE(ai.processed_at, m.created_at) AS since
          FROM message_ai ai
          JOIN messages m ON m.id = ai.message_id
          JOIN retention r ON r.user_id = m.user_id
          WHERE ai.spam_verdict = 'spam'
            AND m.screening_status = 'allowed'
            AND NOT m.is_deleted AND NOT m.is_archived AND NOT m.is_sent
            AND COALESCE(ai.processed_at, m.created_at) < r.cutoff
        )
        UNION ALL
        (
          -- GREATEST skips a NULL, so blocked mail with no decision row left
          -- to date it falls back to its arrival.
          SELECT m.id, m.screening_status, GREATEST(m.created_at, sd.updated_at) AS since
          FROM messages m
          JOIN retention r ON r.user_id = m.user_id
          LEFT JOIN LATERAL effective_sender_decision(m.user_id, m.from_address) d ON true
          LEFT JOIN sender_decisions sd ON sd.user_id = m.user_id AND sd.address = d.address
          WHERE m.screening_status = 'blocked'
            AND NOT m.is_deleted AND NOT m.is_sent
            AND GREATEST(m.created_at, sd.updated_at) < r.cutoff
        )
        ORDER BY since
        LIMIT ${PURGE_LIMIT}
      )
      UPDATE messages m
      SET is_deleted = true, search_indexed_at = NULL
      FROM expired
      -- Block, Unblock and Accept can commit while this UPDATE waits for its
      -- message row lock, and each restarts or ends the clock. Recheck the
      -- target against the disposition the candidate was chosen under.
      WHERE m.id = expired.id AND m.screening_status = expired.screening_status
      RETURNING m.id, m.screening_status
    `,
    );
    if (rows.length) {
      const blocked = rows.filter((row) => row.screening_status === 'blocked').length;
      console.log(JSON.stringify({ event: 'spam_purged', deleted: rows.length, blocked }));
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
