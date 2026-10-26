import { addDocuments, meiliAvailable } from '../../../shared/meili.js';
import { DOCUMENTS_INDEX } from '../../../shared/meili/documents.js';
import { TASKS_INDEX } from '../../../shared/meili/tasks.js';
import {
  documentsDriftPage,
  taskItemsDriftPage,
  stampIndexed,
} from '../../../shared/searchQueries.js';
import { syncMessagesToMeili } from '../../../shared/meiliSync.js';
import { retryWithFreshClient } from '../../../shared/transient-db.js';
import { captureHandledException } from './sentry.js';

// One tick's worth of repair. The corpus is small (~1.6k messages), so this
// is headroom rather than a throttle: it exists so a pathological backlog —
// renaming a label attached to thousands of messages, say — is spread over
// several ticks instead of one very long invocation.
export const SWEEP_LIMIT = 200;
export const WORKSPACE_SWEEP_LIMIT = 25;
export const WORKSPACE_SWEEP_CRON = '7,22,37,52 * * * *';

/**
 * A bounded repair pass on its own cron invocation: Meili task polling must
 * not consume the subrequest allowance reserved for inbound enrichment.
 * Successful indexing alone does not stamp a row that changed during upload.
 *
 * @param {any} env
 * @param {{createSql?: (url: string) => any, add?: typeof addDocuments}} [deps]
 */
export async function sweepWorkspaceSearchDrift(env, deps = {}) {
  if (!meiliAvailable(env) || !deps.createSql) return;
  const makeSql = deps.createSql;
  const add = deps.add ?? addDocuments;
  for (const { descriptor, select } of [
    { descriptor: DOCUMENTS_INDEX, select: documentsDriftPage },
    { descriptor: TASKS_INDEX, select: taskItemsDriftPage },
  ]) {
    let selected = 0;
    let selectedIds = [];
    try {
      const result = await retryWithFreshClient(
        () => makeSql(env.HYPERDRIVE.connectionString),
        async (sql) => {
          const rows = await select(sql, { limit: WORKSPACE_SWEEP_LIMIT });
          selected = rows.length;
          selectedIds = rows.map((row) => String(row.id));
          if (!selected) return null;
          await add(env, descriptor, rows);
          await stampIndexed(
            sql,
            /** @type {'documents' | 'task_items'} */ (descriptor.name),
            rows.map((row) => String(row.id)),
            rows.map((row) => row.row_version),
            rows.map((row) => row.child_versions ?? ''),
          );
          return {
            selected,
            indexed: selected,
            failed: 0,
            oldest_age_seconds: Math.max(
              0,
              Math.floor((Date.now() - new Date(rows[0].updated_at).getTime()) / 1000),
            ),
          };
        },
      );
      if (result) {
        console.log(
          JSON.stringify({
            event: 'workspace_search_drift_swept',
            target: descriptor.name,
            ...result,
          }),
        );
      }
    } catch (error) {
      console.log(
        JSON.stringify({
          event: 'workspace_search_drift_failed',
          target: descriptor.name,
          selected,
          failed: selected,
          document_ids: selectedIds,
        }),
      );
      captureHandledException(
        'workspace_search_drift_sweep',
        error,
        [env.HYPERDRIVE.connectionString, env.MEILISEARCH_API_KEY],
        { target: descriptor.name, selected, document_ids: selectedIds },
      );
    }
  }
}

/**
 * Reindexes messages whose search document is not known to be current.
 *
 * `search_indexed_at IS NULL` is the drift marker: a fresh INSERT has never
 * been indexed, and every handler that changes an indexed field sets the
 * column back to NULL before attempting its own immediate sync. So this sweep
 * is the safety net for writers that index after their response: mail ingest,
 * cookie-web-send's sent copies, and document and task saves. A sync that
 * fails, or runs past its waitUntil budget, leaves the row NULL until this
 * sweep stamps it. (Cookie-Web's `api/send.js` only proxies to cookie-web-send
 * now and writes no message rows.)
 *
 * The ORDER BY matches `messages_search_drift_idx (created_at) WHERE
 * search_indexed_at IS NULL` from migration 0055 so the partial index is
 * usable; newest first, because recent mail is what someone is most likely
 * to search for. Errors are logged and swallowed — a failed sweep must never
 * surface as a failed cron. A dropped Hyperdrive socket (Sentry
 * COOKIE-WEB-10) gets a fresh client and another go first; reindexing is
 * idempotent, so a re-run is safe.
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
  try {
    const swept = await retryWithFreshClient(
      () => makeSql(env.HYPERDRIVE.connectionString),
      async (sql) => {
        const rows = await sql`
          SELECT id
          FROM messages
          WHERE search_indexed_at IS NULL
          ORDER BY created_at DESC
          LIMIT ${SWEEP_LIMIT}
        `;
        if (!rows.length) return null;

        // syncMessagesToMeili swallows its own errors and resolves either
        // way, so the returned counts — not the absence of a throw — are
        // what say whether this tick actually repaired anything.
        const { indexed, failed, error } = await sync(
          sql,
          env,
          rows.map((row) => String(row.id)),
        );
        return { selected: rows.length, indexed, failed, error };
      },
    );
    if (!swept) return;

    const { selected, indexed, failed, error } = swept;
    console.log(JSON.stringify({ event: 'search_drift_swept', selected, indexed, failed, error }));
    if (failed > 0) {
      // The sweep is the last line of defence for rows nothing else can
      // repair. A silent partial failure here is how an index rots unnoticed.
      // The message stays fixed so every tick groups into one issue; the
      // underlying error (a 530 from the tunnel, say) rides along as extra.
      captureHandledException(
        'search_drift_sweep',
        new Error(`${failed} of ${selected} drifted messages failed to reindex`),
        [env.HYPERDRIVE.connectionString, env.MEILISEARCH_API_KEY],
        { selected, indexed, failed, error },
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
  }
}
