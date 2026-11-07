import { addDocuments, failedTasksSince, meiliAvailable } from '../../../shared/meili.js';
import { DOCUMENTS_INDEX } from '../../../shared/meili/documents.js';
import { TASKS_INDEX } from '../../../shared/meili/tasks.js';
import {
  documentsDriftBacklog,
  documentsDriftPage,
  messagesDriftBacklog,
  taskItemsDriftBacklog,
  taskItemsDriftPage,
  stampIndexed,
} from '../../../shared/searchQueries.js';
import { syncMessagesToMeili } from '../../../shared/meiliSync.js';
import { setSpanAttributes } from '../../../shared/tracing.js';
import { retryWithFreshClient } from '../../../shared/transient-db.js';
import { positiveSetting } from './inboundHealth.js';
import { captureHandledException, captureSearchHealthIssue } from './sentry.js';

// One tick's worth of repair. The corpus is small (~1.6k messages), so this
// is headroom rather than a throttle: it exists so a pathological backlog —
// renaming a label attached to thousands of messages, say — is spread over
// several ticks instead of one very long invocation.
export const SWEEP_LIMIT = 200;
export const WORKSPACE_SWEEP_LIMIT = 25;
export const WORKSPACE_SWEEP_CRON = '7,22,37,52 * * * *';
// The interval between workspace ticks, which is also how far back each tick
// looks for indexing tasks Meilisearch failed.
export const WORKSPACE_SWEEP_INTERVAL_MS = 15 * 60_000;

// The sweeps log what they repaired, but an index can rot while every tick
// reports success: a writer that marks rows faster than 200 a quarter hour
// can be drained, or a document Meilisearch keeps rejecting, leaves rows
// unstamped tick after tick. So each tick also measures what it left behind
// and raises a fixed-fingerprint issue past these thresholds.

// Default for SEARCH_BACKLOG_MAX_ROWS. The message sweep drains 200 rows a
// tick, 800 an hour, so more than this many unstamped messages after a tick
// means the index is over an hour behind even if every push succeeds. A
// healthy tick leaves none. Messages have no change time (see
// messagesDriftBacklog), so their backlog is measured by count alone.
export const DEFAULT_SEARCH_BACKLOG_MAX_ROWS = 1000;

// Default for SEARCH_STALE_MAX_MINUTES. Documents and tasks drift oldest-first
// at 25 a tick, so an edit still unindexed after an hour has been passed over
// by four ticks: the pushes are failing, or the edit rate is beyond the bound.
export const DEFAULT_SEARCH_STALE_MAX_MINUTES = 60;

/**
 * @param {Date | string | null | undefined} oldest
 * @param {number} now
 */
function ageSeconds(oldest, now) {
  if (!oldest) return 0;
  const at = new Date(oldest).getTime();
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 1000)) : 0;
}

/**
 * A bounded repair pass on its own cron invocation: Meili task polling must
 * not consume the subrequest allowance reserved for inbound enrichment.
 * Successful indexing alone does not stamp a row that changed during upload.
 *
 * @param {any} env
 * @param {{createSql?: (url: string) => any, add?: typeof addDocuments, failedTasks?: typeof failedTasksSince, now?: () => number}} [deps]
 */
export async function sweepWorkspaceSearchDrift(env, deps = {}) {
  if (!meiliAvailable(env) || !deps.createSql) return;
  const makeSql = deps.createSql;
  const add = deps.add ?? addDocuments;
  const staleMaxMinutes = positiveSetting(
    env.SEARCH_STALE_MAX_MINUTES,
    DEFAULT_SEARCH_STALE_MAX_MINUTES,
  );
  for (const { descriptor, select, backlog } of [
    { descriptor: DOCUMENTS_INDEX, select: documentsDriftPage, backlog: documentsDriftBacklog },
    { descriptor: TASKS_INDEX, select: taskItemsDriftPage, backlog: taskItemsDriftBacklog },
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
          // What this tick left behind. Only rows the stamp did not take
          // (changed during upload, or more than one tick's worth) remain.
          const [remaining] = await backlog(sql);
          const now = Date.now();
          return {
            selected,
            indexed: selected,
            failed: 0,
            oldest_age_seconds: ageSeconds(rows[0].updated_at, now),
            backlog: Number(remaining?.backlog ?? 0),
            backlog_age_seconds: ageSeconds(remaining?.oldest, now),
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
        setSpanAttributes({
          [`cookie.search.${descriptor.name}.backlog`]: result.backlog,
          [`cookie.search.${descriptor.name}.backlog_age_seconds`]: result.backlog_age_seconds,
        });
        if (result.backlog_age_seconds > staleMaxMinutes * 60) {
          captureSearchHealthIssue(
            `${descriptor.name}-stale`,
            'Search index repair is falling behind',
            {
              target: descriptor.name,
              backlog: result.backlog,
              backlog_age_seconds: result.backlog_age_seconds,
              threshold_minutes: staleMaxMinutes,
            },
          );
        }
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
  await reportFailedMeiliTasks(env, deps);
}

/**
 * Indexing tasks Meilisearch accepted and then failed over the last tick's
 * interval — a document it cannot index, or an embedder call OpenAI refused.
 * Writers that do not wait for their task (mail ingest's first push) never
 * learn of these, and a sweep only sees the row stay unstamped; this is the
 * one place the failure itself is reported. Runs on the workspace tick, which
 * has its own subrequest budget, so the lookup never competes with inbound
 * enrichment. A failing lookup is reported and never fails the cron.
 *
 * @param {any} env
 * @param {{failedTasks?: typeof failedTasksSince, now?: () => number}} [deps]
 */
export async function reportFailedMeiliTasks(env, deps = {}) {
  if (!meiliAvailable(env)) return;
  const failedTasks = deps.failedTasks ?? failedTasksSince;
  const now = deps.now ?? Date.now;
  try {
    const { total, sample } = await failedTasks(env, new Date(now() - WORKSPACE_SWEEP_INTERVAL_MS));
    setSpanAttributes({ 'cookie.search.failed_tasks': total });
    if (!total) return;
    const detail = {
      total,
      index: sample?.indexUid,
      type: sample?.type,
      error_code: sample?.errorCode,
      task_uid: sample?.uid,
    };
    console.log(JSON.stringify({ event: 'meili_tasks_failed', ...detail }));
    captureSearchHealthIssue('meili-task-failures', 'Meilisearch failed indexing tasks', detail);
  } catch (error) {
    console.log(JSON.stringify({ event: 'meili_tasks_check_failed' }));
    captureHandledException('meili_tasks_check', error, [env.MEILISEARCH_API_KEY]);
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
        // What this tick left behind: the rows the sync could not index,
        // plus everything beyond the 200 it selected.
        const [remaining] = await messagesDriftBacklog(sql);
        return {
          selected: rows.length,
          indexed,
          failed,
          error,
          backlog: Number(remaining?.backlog ?? 0),
        };
      },
    );
    if (!swept) return;

    const { selected, indexed, failed, error, backlog } = swept;
    console.log(
      JSON.stringify({ event: 'search_drift_swept', selected, indexed, failed, error, backlog }),
    );
    setSpanAttributes({ 'cookie.search.messages.backlog': backlog });
    const backlogMaxRows = positiveSetting(
      env.SEARCH_BACKLOG_MAX_ROWS,
      DEFAULT_SEARCH_BACKLOG_MAX_ROWS,
    );
    if (backlog > backlogMaxRows) {
      captureSearchHealthIssue('messages-backlog', 'Search index repair is falling behind', {
        target: 'messages',
        backlog,
        threshold_rows: backlogMaxRows,
        indexed,
        failed,
      });
    }
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
