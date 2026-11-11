import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  BASELINE_MIN_CALLS,
  CONNECTION_USAGE_MAX,
  DEFAULT_DB_LONG_QUERY_SECONDS,
  DEFAULT_DB_REGRESSION_MIN_MS,
  LOCK_WAIT_SECONDS,
  REGRESSION_FACTOR,
  REGRESSION_MIN_CALLS,
  checkActivity,
  checkQueryRegressions,
  runDbHealthChecks,
} from '../src/dbHealth.js';

const QUERY_TEXT = 'SELECT m.id FROM messages m WHERE m.user_id = $1 AND m.subject = $2';

/**
 * A fake postgres tagged template. It records each query and answers with `rows`.
 * @param {unknown[] | Error} rows
 */
function fakeSql(rows = []) {
  /** @type {{text: string, values: unknown[]}[]} */
  const queries = [];
  /** @type {any} */
  const sql = async (/** @type {TemplateStringsArray} */ strings, ...values) => {
    queries.push({ text: strings.join('?'), values });
    if (rows instanceof Error) throw rows;
    return rows;
  };
  return { sql, queries };
}

/**
 * A healthy activity row, with overrides.
 * @param {Record<string, unknown>} [overrides]
 */
function activityRow(overrides = {}) {
  return {
    long_running: 0,
    longest_seconds: 0,
    lock_waiting: 0,
    connections: 19,
    max_connections: 60,
    ...overrides,
  };
}

/**
 * A createSql stand-in that answers each health query by its SQL, so the
 * whole runner can run without a database. Each answer is rows or an error.
 * @param {{regressions?: unknown[] | Error, activity?: unknown[] | Error}} [state]
 */
function healthSql({ regressions = [], activity = [activityRow()] } = {}) {
  /** @type {any[]} */
  const clients = [];
  const createSql = () => {
    /** @type {any} */
    const sql = async (/** @type {TemplateStringsArray} */ strings) => {
      const text = strings.join('?');
      const answer = text.includes('pg_stat_statements') ? regressions : activity;
      if (answer instanceof Error) throw answer;
      return answer;
    };
    sql.end = vi.fn(async () => undefined);
    clients.push(sql);
    return sql;
  };
  return { createSql, clients };
}

/** @returns {any} */
function env(overrides = {}) {
  return { HYPERDRIVE: { connectionString: 'postgres://user:secret@host/db' }, ...overrides };
}

/** @param {string} code */
function sqlError(code) {
  return Object.assign(new Error(`failed with ${code}`), { code });
}

/** @type {import('vitest').MockInstance} */
let log;

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  log.mockRestore();
});

/** The structured lines the run logged, parsed. */
function logged() {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)));
}

describe('checkQueryRegressions', () => {
  test('compares the statements of this role with the previous snapshot and replaces it', async () => {
    const { sql, queries } = fakeSql([]);

    await expect(checkQueryRegressions(sql, { minMs: 250 })).resolves.toEqual({
      available: true,
      statements: [],
    });

    expect(queries).toHaveLength(1);
    const [{ text, values }] = queries;
    expect(text).toContain('FROM extensions.pg_stat_statements');
    expect(text).toContain('rolname = current_user');
    expect(text).toContain('datname = current_database()');
    expect(text).toContain('JOIN db_query_stats');
    expect(text).toContain('INSERT INTO db_query_stats');
    expect(text).toContain('DELETE FROM db_query_stats');
    expect(values).toEqual([REGRESSION_MIN_CALLS, BASELINE_MIN_CALLS, 250, REGRESSION_FACTOR, 5]);
  });

  test('names each regressed statement by its id and operation, never its text', async () => {
    const { sql } = fakeSql([
      {
        queryid: '-8123456789012345678',
        query: QUERY_TEXT,
        calls: 7,
        mean_ms: 640.1234,
        baseline_ms: 12.3456,
      },
      {
        queryid: '42',
        query: '  update message_ai set status = $1',
        calls: '5',
        mean_ms: '900',
        baseline_ms: '250.04',
      },
    ]);

    const result = await checkQueryRegressions(sql, { minMs: DEFAULT_DB_REGRESSION_MIN_MS });

    expect(result).toEqual({
      available: true,
      statements: [
        {
          queryid: '-8123456789012345678',
          operation: 'SELECT',
          calls: 7,
          meanMs: 640.1,
          baselineMs: 12.3,
        },
        { queryid: '42', operation: 'UPDATE', calls: 5, meanMs: 900, baselineMs: 250 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('messages');
  });

  test.each(['42P01', '3F000'])(
    'reads a missing table or schema (%s) as unavailable',
    async (code) => {
      const { sql } = fakeSql(sqlError(code));
      await expect(checkQueryRegressions(sql, { minMs: 200 })).resolves.toEqual({
        available: false,
      });
    },
  );

  test('lets any other failure through', async () => {
    const { sql } = fakeSql(sqlError('57014'));
    await expect(checkQueryRegressions(sql, { minMs: 200 })).rejects.toThrow('57014');
  });
});

describe('checkActivity', () => {
  test('reads long queries, lock waits and connection usage for client sessions', async () => {
    const { sql, queries } = fakeSql([
      activityRow({ long_running: 2, longest_seconds: 95.6, lock_waiting: 1, connections: 48 }),
    ]);

    await expect(checkActivity(sql, { longSeconds: 45 })).resolves.toEqual({
      longRunning: 2,
      longestSeconds: 96,
      lockWaiting: 1,
      connections: 48,
      maxConnections: 60,
      connectionUsage: 0.8,
    });

    const [{ text, values }] = queries;
    expect(text).toContain('FROM pg_stat_activity');
    expect(text).toContain("backend_type = 'client backend'");
    expect(text).toContain('pg_backend_pid()');
    expect(values).toEqual([45, LOCK_WAIT_SECONDS]);
  });

  test('reads an empty answer as an idle database', async () => {
    const { sql } = fakeSql([]);
    await expect(checkActivity(sql, { longSeconds: 30 })).resolves.toEqual({
      longRunning: 0,
      longestSeconds: 0,
      lockWaiting: 0,
      connections: 0,
      maxConnections: 0,
      connectionUsage: 0,
    });
  });
});

describe('runDbHealthChecks', () => {
  test('reports nothing for a healthy database and logs what it saw', async () => {
    const { createSql, clients } = healthSql();
    const report = vi.fn();
    const reportFailure = vi.fn();

    await runDbHealthChecks(env(), { createSql, report, reportFailure });

    expect(report).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
    expect(logged()).toEqual([
      {
        event: 'db_health_checked',
        regressed: 0,
        long_running: 0,
        lock_waiting: 0,
        connections: 19,
        max_connections: 60,
      },
    ]);
    // Each check gets a client of its own and closes it.
    expect(clients).toHaveLength(2);
    expect(clients.every((sql) => sql.end.mock.calls.length === 1)).toBe(true);
  });

  test('reports regressed statements under one fingerprint, with ids and timings only', async () => {
    const { createSql } = healthSql({
      regressions: [
        { queryid: '111', query: QUERY_TEXT, calls: 9, mean_ms: 812.44, baseline_ms: 31.2 },
        { queryid: '222', query: 'DELETE FROM drafts', calls: 5, mean_ms: 300, baseline_ms: 40 },
      ],
    });
    const report = vi.fn();

    await runDbHealthChecks(env({ DB_REGRESSION_MIN_MS: '250' }), {
      createSql,
      report,
      reportFailure: vi.fn(),
    });

    expect(report).toHaveBeenCalledExactlyOnceWith(
      'query-regression',
      'Database statements are running slower than their baseline',
      {
        statements: 2,
        queryids: '111,222',
        worst_queryid: '111',
        worst_operation: 'SELECT',
        worst_calls: 9,
        worst_mean_ms: 812.4,
        worst_baseline_ms: 31.2,
        threshold_ms: 250,
        threshold_factor: REGRESSION_FACTOR,
      },
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain('messages');
    expect(JSON.stringify(logged())).not.toContain('messages');
    expect(logged()[0]).toMatchObject({ event: 'db_health_checked', regressed: 2 });
  });

  test('reports long queries, lock waits and a nearly full connection pool separately', async () => {
    const { createSql } = healthSql({
      activity: [
        activityRow({ long_running: 1, longest_seconds: 310, lock_waiting: 2, connections: 55 }),
      ],
    });
    const report = vi.fn();

    await runDbHealthChecks(env({ DB_LONG_QUERY_SECONDS: '120' }), {
      createSql,
      report,
      reportFailure: vi.fn(),
    });

    expect(report.mock.calls).toEqual([
      [
        'long-running-query',
        'Database queries have been running for a long time',
        { queries: 1, longest_seconds: 310, threshold_seconds: 120 },
      ],
      [
        'lock-wait',
        'Database sessions are waiting on locks',
        { sessions: 2, threshold_seconds: LOCK_WAIT_SECONDS },
      ],
      [
        'connection-saturation',
        'Database connections are close to the limit',
        { connections: 55, max_connections: 60, threshold_share: CONNECTION_USAGE_MAX },
      ],
    ]);
  });

  test('falls back to the default thresholds for unusable settings', async () => {
    const { createSql } = healthSql({
      regressions: [{ queryid: '1', query: 'SELECT 1', calls: 5, mean_ms: 500, baseline_ms: 5 }],
      activity: [activityRow({ long_running: 1, longest_seconds: 40 })],
    });
    const report = vi.fn();

    await runDbHealthChecks(env({ DB_REGRESSION_MIN_MS: 'fast', DB_LONG_QUERY_SECONDS: '0' }), {
      createSql,
      report,
      reportFailure: vi.fn(),
    });

    expect(report.mock.calls[0][2]).toMatchObject({ threshold_ms: DEFAULT_DB_REGRESSION_MIN_MS });
    expect(report.mock.calls[1][2]).toMatchObject({
      threshold_seconds: DEFAULT_DB_LONG_QUERY_SECONDS,
    });
  });

  test('reports a check that could not run, without stopping the other or throwing', async () => {
    const connection = 'postgres://user:secret@host/db';
    const { createSql } = healthSql({
      regressions: sqlError('57014'),
      activity: [activityRow({ lock_waiting: 1 })],
    });
    const report = vi.fn();
    const reportFailure = vi.fn();

    await expect(
      runDbHealthChecks(env(), { createSql, report, reportFailure }),
    ).resolves.toBeUndefined();

    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
      'db_health',
      expect.objectContaining({ code: '57014' }),
      [connection],
      { check: 'query_regressions' },
    );
    expect(report).toHaveBeenCalledExactlyOnceWith(
      'lock-wait',
      'Database sessions are waiting on locks',
      expect.any(Object),
    );

    const failing = healthSql({ activity: new Error('connection refused') });
    reportFailure.mockClear();
    await expect(
      runDbHealthChecks(env(), { createSql: failing.createSql, report, reportFailure }),
    ).resolves.toBeUndefined();
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(
      'db_health',
      expect.any(Error),
      [connection],
      { check: 'activity' },
    );
    expect(failing.clients.every((sql) => sql.end.mock.calls.length === 1)).toBe(true);
  });

  // Until the snapshot table's migration is applied the comparison cannot
  // run. That is expected during a rollout, so it is said once per isolate
  // and is neither a Sentry issue nor a failure.
  test('skips the comparison quietly while the snapshot table is missing', async () => {
    const { createSql } = healthSql({ regressions: sqlError('42P01') });
    const report = vi.fn();
    const reportFailure = vi.fn();

    await runDbHealthChecks(env(), { createSql, report, reportFailure });
    await runDbHealthChecks(env(), { createSql, report, reportFailure });

    expect(report).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
    const events = logged().map((line) => line.event);
    expect(events.filter((event) => event === 'db_query_stats_unavailable')).toHaveLength(1);
    expect(events.filter((event) => event === 'db_health_checked')).toHaveLength(2);
    expect(logged().at(-1)).not.toHaveProperty('regressed');
  });
});
