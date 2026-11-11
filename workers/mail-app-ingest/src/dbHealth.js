import { operationName } from '../../../shared/db-tracing.js';
import { positiveSetting, withSql } from './inboundHealth.js';
import { captureDbHealthIssue, captureHandledException } from './sentry.js';

// The Workers time their own queries (shared/sqlMetrics.js), but only the
// database sees every client: the Vercel functions, Cookie-Agents and the
// migration runner as well. These checks read Postgres's own statistics once
// per 15-minute tick. They read counters and session states only; a
// statement's text is used to name its operation and goes no further.

// Default for DB_REGRESSION_MIN_MS. A statement is only called slower when
// its recent mean is at least this long, however fast it used to be. Of the
// 386 statements with a baseline on 2026-11-11, 312 averaged under 10 ms and
// four over 200 ms, so three times a small baseline is still nothing a user
// would notice; 200 ms is where a single query starts to show in a request.
export const DEFAULT_DB_REGRESSION_MIN_MS = 200;

// Default for DB_LONG_QUERY_SECONDS. The slowest statement on record takes a
// few seconds, so a query still active after half a minute is stuck or
// waiting, not working.
export const DEFAULT_DB_LONG_QUERY_SECONDS = 30;

// A statement has regressed when its mean since the last tick is this many
// times its mean over everything before that tick.
export const REGRESSION_FACTOR = 3;
// Calls a statement needs since the last tick before its recent mean is
// trusted, and calls it needs before that for its baseline to be trusted.
export const REGRESSION_MIN_CALLS = 5;
export const BASELINE_MIN_CALLS = 20;
// Sessions waiting on a lock for longer than this are reported.
export const LOCK_WAIT_SECONDS = 10;
// Share of max_connections in use above which the pool is close to refusing
// new sessions.
export const CONNECTION_USAGE_MAX = 0.8;

const REPORT_LIMIT = 5;

// undefined_table and invalid_schema_name: the snapshot table's migration is
// not applied yet, or the database has no pg_stat_statements.
const NOT_INSTALLED = new Set(['42P01', '3F000']);

// Said once per isolate rather than on every cron tick, like the skipped
// routing check.
let notInstalledLogged = false;

/**
 * Statements whose mean execution time since the previous tick is well above
 * their mean before it, and the snapshot the next tick compares against, in
 * one statement so the comparison and the new snapshot read the same counters.
 *
 * `db_query_stats` holds each statement's call count and total time as of the
 * previous tick. The difference from pg_stat_statements now is the last
 * interval; the snapshot itself is the baseline. A statement whose counters
 * went backwards (a statistics reset, or an entry evicted and re-added) is
 * not compared this tick and gets a fresh snapshot. Only this role's own
 * data statements in this database are tracked, which leaves out Supabase's
 * internal sessions and transaction control.
 *
 * @param {import('postgres').Sql} sql
 * @param {{minMs: number}} options
 * @returns {Promise<{available: false} | {available: true, statements: {queryid: string, operation: string, calls: number, meanMs: number, baselineMs: number}[]}>}
 */
export async function checkQueryRegressions(sql, { minMs }) {
  let rows;
  try {
    rows = await sql`
      WITH current AS (
        SELECT s.queryid,
               sum(s.calls)::bigint AS calls,
               sum(s.total_exec_time)::float8 AS total_ms,
               max(s.query) AS query
        FROM extensions.pg_stat_statements s
        WHERE s.userid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND s.queryid IS NOT NULL
          AND s.query ~* '^\\s*(select|insert|update|delete|with|merge)\\M'
        GROUP BY s.queryid
      ), regressed AS (
        SELECT c.queryid,
               c.query,
               c.calls - p.calls AS calls,
               (c.total_ms - p.total_ms) / NULLIF(c.calls - p.calls, 0) AS mean_ms,
               p.total_ms / NULLIF(p.calls, 0) AS baseline_ms
        FROM current c
        JOIN db_query_stats p ON p.queryid = c.queryid
        WHERE c.calls - p.calls >= ${REGRESSION_MIN_CALLS}::bigint
          AND p.calls >= ${BASELINE_MIN_CALLS}::bigint
          AND c.total_ms >= p.total_ms
          AND (c.total_ms - p.total_ms) / NULLIF(c.calls - p.calls, 0)
              >= GREATEST(
                ${minMs}::float8,
                ${REGRESSION_FACTOR}::float8 * p.total_ms / NULLIF(p.calls, 0)
              )
      ), saved AS (
        INSERT INTO db_query_stats (queryid, calls, total_ms, captured_at)
        SELECT c.queryid, c.calls, c.total_ms, now() FROM current c
        ON CONFLICT (queryid) DO UPDATE
          SET calls = EXCLUDED.calls,
              total_ms = EXCLUDED.total_ms,
              captured_at = EXCLUDED.captured_at
          WHERE db_query_stats.calls IS DISTINCT FROM EXCLUDED.calls
      ), pruned AS (
        DELETE FROM db_query_stats p
        WHERE NOT EXISTS (SELECT 1 FROM current c WHERE c.queryid = p.queryid)
      )
      SELECT r.queryid::text AS queryid,
             r.query,
             r.calls::int AS calls,
             r.mean_ms::float8 AS mean_ms,
             r.baseline_ms::float8 AS baseline_ms
      FROM regressed r
      ORDER BY (r.mean_ms - r.baseline_ms) * r.calls DESC
      LIMIT ${REPORT_LIMIT}
    `;
  } catch (err) {
    if (NOT_INSTALLED.has(String(/** @type {{code?: unknown}} */ (err)?.code))) {
      return { available: false };
    }
    throw err;
  }
  return {
    available: true,
    statements: rows.map((row) => ({
      queryid: String(row.queryid),
      operation: operationName([String(row.query ?? '')]) ?? 'unknown',
      calls: Number(row.calls),
      meanMs: Math.round(Number(row.mean_ms) * 10) / 10,
      baselineMs: Math.round(Number(row.baseline_ms) * 10) / 10,
    })),
  };
}

/**
 * What the database's sessions are doing right now: this role's queries that
 * have been running for too long, its sessions stuck behind a lock (counted
 * apart, so one blocked statement is not reported twice), and how many of the
 * server's connection slots are taken. A sample every 15 minutes
 * only sees a condition that lasts, which is the kind worth an alert;
 * Postgres logs each lock wait itself as it happens.
 *
 * @param {import('postgres').Sql} sql
 * @param {{longSeconds: number}} options
 */
export async function checkActivity(sql, { longSeconds }) {
  const [row] = await sql`
    SELECT
      count(*) FILTER (
        WHERE a.usename = current_user
          AND a.state = 'active'
          AND a.wait_event_type IS DISTINCT FROM 'Lock'
          AND a.query_start < now() - make_interval(secs => ${longSeconds}::float8)
      )::int AS long_running,
      COALESCE(
        max(EXTRACT(EPOCH FROM now() - a.query_start)) FILTER (
          WHERE a.usename = current_user
            AND a.state = 'active'
            AND a.wait_event_type IS DISTINCT FROM 'Lock'
        ),
        0
      )::float8 AS longest_seconds,
      count(*) FILTER (
        WHERE a.usename = current_user
          AND a.wait_event_type = 'Lock'
          AND a.query_start < now() - make_interval(secs => ${LOCK_WAIT_SECONDS}::float8)
      )::int AS lock_waiting,
      count(*)::int AS connections,
      current_setting('max_connections')::int AS max_connections
    FROM pg_stat_activity a
    WHERE a.backend_type = 'client backend'
      AND a.pid <> pg_backend_pid()
  `;
  const connections = Number(row?.connections ?? 0);
  const maxConnections = Number(row?.max_connections ?? 0);
  return {
    longRunning: Number(row?.long_running ?? 0),
    longestSeconds: Math.round(Number(row?.longest_seconds ?? 0)),
    lockWaiting: Number(row?.lock_waiting ?? 0),
    connections,
    maxConnections,
    connectionUsage: maxConnections > 0 ? connections / maxConnections : 0,
  };
}

/**
 * Runs the database health checks and reports each failing condition to
 * Sentry under a fixed fingerprint. It never throws: the scheduled handler
 * awaits it after the ingest sweeps and the inbound checks, and a failing
 * check must not change the cron's outcome.
 *
 * @param {Env & {DB_REGRESSION_MIN_MS?: string, DB_LONG_QUERY_SECONDS?: string}} env
 * @param {{
 *   createSql: (url: string) => any,
 *   report?: typeof captureDbHealthIssue,
 *   reportFailure?: typeof captureHandledException,
 * }} deps
 */
export async function runDbHealthChecks(env, deps) {
  const report = deps.report ?? captureDbHealthIssue;
  const reportFailure = deps.reportFailure ?? captureHandledException;
  const connection = env.HYPERDRIVE?.connectionString;
  const minMs = positiveSetting(env.DB_REGRESSION_MIN_MS, DEFAULT_DB_REGRESSION_MIN_MS);
  const longSeconds = positiveSetting(env.DB_LONG_QUERY_SECONDS, DEFAULT_DB_LONG_QUERY_SECONDS);
  /** @type {Record<string, unknown>} */
  const summary = { event: 'db_health_checked' };

  try {
    const regressions = await withSql(deps.createSql, connection, (sql) =>
      checkQueryRegressions(sql, { minMs }),
    );
    if (!regressions.available) {
      if (!notInstalledLogged) {
        notInstalledLogged = true;
        console.log(JSON.stringify({ event: 'db_query_stats_unavailable' }));
      }
    } else {
      const [worst] = regressions.statements;
      summary.regressed = regressions.statements.length;
      if (worst) {
        // Query ids and timings only. The id finds the statement's text in
        // pg_stat_statements, which stays in the database.
        report('query-regression', 'Database statements are running slower than their baseline', {
          statements: regressions.statements.length,
          queryids: regressions.statements.map((statement) => statement.queryid).join(','),
          worst_queryid: worst.queryid,
          worst_operation: worst.operation,
          worst_calls: worst.calls,
          worst_mean_ms: worst.meanMs,
          worst_baseline_ms: worst.baselineMs,
          threshold_ms: minMs,
          threshold_factor: REGRESSION_FACTOR,
        });
      }
    }
  } catch (err) {
    reportFailure('db_health', err, [connection], { check: 'query_regressions' });
  }

  try {
    const activity = await withSql(deps.createSql, connection, (sql) =>
      checkActivity(sql, { longSeconds }),
    );
    summary.long_running = activity.longRunning;
    summary.lock_waiting = activity.lockWaiting;
    summary.connections = activity.connections;
    summary.max_connections = activity.maxConnections;
    if (activity.longRunning > 0) {
      report('long-running-query', 'Database queries have been running for a long time', {
        queries: activity.longRunning,
        longest_seconds: activity.longestSeconds,
        threshold_seconds: longSeconds,
      });
    }
    if (activity.lockWaiting > 0) {
      report('lock-wait', 'Database sessions are waiting on locks', {
        sessions: activity.lockWaiting,
        threshold_seconds: LOCK_WAIT_SECONDS,
      });
    }
    if (activity.connectionUsage >= CONNECTION_USAGE_MAX) {
      report('connection-saturation', 'Database connections are close to the limit', {
        connections: activity.connections,
        max_connections: activity.maxConnections,
        threshold_share: CONNECTION_USAGE_MAX,
      });
    }
  } catch (err) {
    reportFailure('db_health', err, [connection], { check: 'activity' });
  }

  console.log(JSON.stringify(summary));
}
