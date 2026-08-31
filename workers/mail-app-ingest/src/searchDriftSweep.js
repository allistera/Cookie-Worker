import { meiliAvailable } from '../../../shared/meili.js';
import { syncMessagesToMeili } from '../../../shared/meiliSync.js';
import { captureHandledException } from './sentry.js';

// One tick's worth of repair. The corpus is small (~1.6k messages), so this
// is headroom rather than a throttle: it exists so a pathological backlog —
// renaming a label attached to thousands of messages, say — is spread over
// several ticks instead of one very long invocation.
export const SWEEP_LIMIT = 200;

/**
 * Reindexes messages whose search document is not known to be current.
 *
 * `search_indexed_at IS NULL` is the drift marker: a fresh INSERT has never
 * been indexed, and every handler that changes an indexed field sets the
 * column back to NULL before attempting its own immediate sync. So this sweep
 * is the safety net for two cases — writers that cannot reach Meilisearch at
 * all (Cookie-Web's `api/send.js` runs on Vercel with no Meilisearch client),
 * and writers whose immediate sync failed or was cut short.
 *
 * The ORDER BY matches `messages_search_drift_idx (created_at) WHERE
 * search_indexed_at IS NULL` from migration 0055 so the partial index is
 * usable; newest first, because recent mail is what someone is most likely
 * to search for. Errors are logged and swallowed — a failed sweep must never
 * surface as a failed cron.
 *
 * @param {any} env
 * @param {{createSql?: (url: string) => any, sync?: typeof syncMessagesToMeili}} [deps]
 */
export async function sweepSearchDrift(env, deps = {}) {
  if (!meiliAvailable(env)) return;

  const makeSql = deps.createSql;
  const sync = deps.sync ?? syncMessagesToMeili;
  if (!makeSql) {
    // A missing injection disables the only repair path for writers that
    // cannot reach Meilisearch themselves, so it must not be silent.
    console.log(JSON.stringify({ event: 'search_drift_sweep_misconfigured' }));
    return;
  }

  // createSql throws on a malformed connection string, so it belongs inside
  // the try: this runs under ctx.waitUntil alongside enrichment recovery, and
  // a rejection here would surface as an unhandled rejection on the cron.
  let sql;
  try {
    sql = makeSql(env.HYPERDRIVE.connectionString);
    const rows = await sql`
      SELECT id
      FROM messages
      WHERE search_indexed_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${SWEEP_LIMIT}
    `;
    if (!rows.length) return;

    // syncMessagesToMeili swallows its own errors and resolves either way, so
    // the returned counts — not the absence of a throw — are what say whether
    // this tick actually repaired anything.
    const { indexed, failed } = await sync(
      sql,
      env,
      rows.map((row) => String(row.id)),
    );
    console.log(
      JSON.stringify({ event: 'search_drift_swept', selected: rows.length, indexed, failed }),
    );
    if (failed > 0) {
      // The sweep is the last line of defence for rows nothing else can
      // repair. A silent partial failure here is how an index rots unnoticed.
      captureHandledException(
        'search_drift_sweep',
        new Error(`${failed} of ${rows.length} drifted messages failed to reindex`),
        [env.HYPERDRIVE.connectionString, env.MEILISEARCH_API_KEY],
        { selected: rows.length, indexed, failed },
      );
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        event: 'search_drift_sweep_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    captureHandledException('search_drift_sweep', err, [
      env.HYPERDRIVE.connectionString,
      env.MEILISEARCH_API_KEY,
    ]);
  } finally {
    await sql?.end({ timeout: 2 }).catch(() => undefined);
  }
}
