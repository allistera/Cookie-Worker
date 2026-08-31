import { meiliAvailable } from '../../../shared/meili.js';
import { syncMessagesToMeili } from '../../../shared/meiliSync.js';

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
  if (!makeSql) return;

  const sql = makeSql(env.HYPERDRIVE.connectionString);
  try {
    const rows = await sql`
      SELECT id
      FROM messages
      WHERE search_indexed_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${SWEEP_LIMIT}
    `;
    if (!rows.length) return;

    await sync(
      sql,
      env,
      rows.map((row) => String(row.id)),
    );
    console.log(JSON.stringify({ event: 'search_drift_swept', count: rows.length }));
  } catch (err) {
    console.log(
      JSON.stringify({
        event: 'search_drift_sweep_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}
