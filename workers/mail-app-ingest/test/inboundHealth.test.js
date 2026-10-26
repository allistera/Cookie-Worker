import { describe, expect, test } from 'vitest';
import {
  checkEmailRoutingDrift,
  checkPendingEnrichment,
  checkStaleInbound,
  positiveSetting,
  runInboundHealthChecks,
} from '../src/inboundHealth.js';

const NOW = new Date('2026-10-26T12:00:00Z');
const ROUTING_URL =
  'https://api.cloudflare.com/client/v4/zones/zone-1/email/routing/rules/catch_all';

/**
 * A fake postgres tagged template. It records each query and answers with `rows`.
 * @param {unknown[]} rows
 */
function fakeSql(rows = []) {
  /** @type {{text: string, values: unknown[]}[]} */
  const queries = [];
  /** @type {any} */
  const sql = async (/** @type {TemplateStringsArray} */ strings, ...values) => {
    queries.push({ text: strings.join('?'), values });
    return rows;
  };
  return { sql, queries };
}

/**
 * A fake fetch that answers with the Cloudflare response envelope.
 * @param {{status?: number, result?: unknown}} [reply]
 */
function fakeFetch(reply = {}) {
  /** @type {{url: string, init: any}[]} */
  const calls = [];
  /** @type {any} */
  const fetchImpl = async (/** @type {any} */ input, /** @type {any} */ init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ success: true, result: reply.result ?? null }), {
      status: reply.status ?? 200,
    });
  };
  return { fetchImpl, calls };
}

/**
 * A sql stand-in that answers each health query by its SQL, so the whole runner
 * can run without a database.
 * @param {{newest?: unknown, pending?: number, oldest?: unknown}} state
 */
function healthSql({ newest = NOW, pending = 0, oldest = null }) {
  return () => {
    /** @type {any} */
    const sql = async (/** @type {TemplateStringsArray} */ strings) => {
      const text = strings.join('?');
      if (text.includes('max(m.created_at)')) return [{ newest }];
      if (text.includes('count(*)')) return [{ pending, oldest }];
      return [];
    };
    sql.end = async () => undefined;
    return sql;
  };
}

describe('positiveSetting', () => {
  test.each([
    [undefined, 12],
    [null, 12],
    ['', 12],
    ['soon', 12],
    ['0', 12],
    ['-3', 12],
  ])('falls back to the default for %j', (value, fallback) => {
    expect(positiveSetting(value, fallback)).toBe(fallback);
  });

  test('reads a positive number, including one given as text', () => {
    expect(positiveSetting('6.5', 12)).toBe(6.5);
    expect(positiveSetting(4, 12)).toBe(4);
  });
});

describe('checkStaleInbound', () => {
  test('is stale when the newest inbound message is older than the threshold', async () => {
    const { sql, queries } = fakeSql([{ newest: new Date('2026-10-25T23:00:00Z') }]);
    const result = await checkStaleInbound(sql, {
      ownerEmail: 'owner@example.com',
      staleHours: 12,
      now: NOW,
    });
    expect(result).toEqual({ stale: true, ageHours: 13, thresholdHours: 12 });
    expect(queries[0].text).toContain('m.is_sent = false');
    expect(queries[0].values).toEqual(['owner@example.com']);
  });

  test('is fresh inside the threshold, and accepts timestamps given as text', async () => {
    const { sql } = fakeSql([{ newest: '2026-10-26T03:00:00Z' }]);
    expect(
      await checkStaleInbound(sql, { ownerEmail: 'owner@example.com', staleHours: 12, now: NOW }),
    ).toEqual({ stale: false, ageHours: 9, thresholdHours: 12 });
  });

  test('is not stale exactly at the threshold', async () => {
    const { sql } = fakeSql([{ newest: '2026-10-26T00:00:00Z' }]);
    expect(
      await checkStaleInbound(sql, { ownerEmail: 'owner@example.com', staleHours: 12, now: NOW }),
    ).toEqual({ stale: false, ageHours: 12, thresholdHours: 12 });
  });

  test('treats an owner with no inbound mail as stale', async () => {
    const { sql } = fakeSql([{ newest: null }]);
    expect(
      await checkStaleInbound(sql, { ownerEmail: 'owner@example.com', staleHours: 12, now: NOW }),
    ).toEqual({ stale: true, ageHours: null, thresholdHours: 12 });
  });
});

describe('checkPendingEnrichment', () => {
  test('counts pending rows older than the limit and reports the oldest age', async () => {
    const { sql, queries } = fakeSql([{ pending: 2, oldest: new Date('2026-10-26T09:30:00Z') }]);
    const result = await checkPendingEnrichment(sql, { maxMinutes: 60, now: NOW });
    expect(result).toEqual({ pending: 2, oldestAgeMinutes: 150, thresholdMinutes: 60 });
    expect(queries[0].text).toContain("ai.status = 'pending'");
    expect(queries[0].text).toContain('ai.created_at <');
    // The cutoff is the limit before now, sent as an ISO timestamp.
    expect(queries[0].values).toEqual(['2026-10-26T11:00:00.000Z']);
  });

  test('reports nothing pending when no row is old enough', async () => {
    const { sql } = fakeSql([{ pending: 0, oldest: null }]);
    expect(await checkPendingEnrichment(sql, { maxMinutes: 60, now: NOW })).toEqual({
      pending: 0,
      oldestAgeMinutes: null,
      thresholdMinutes: 60,
    });
  });
});

describe('checkEmailRoutingDrift', () => {
  const enabledToWorker = {
    enabled: true,
    actions: [{ type: 'worker', value: ['mail-app-ingest'] }],
  };

  test('is clean when the catch-all rule is enabled and names this Worker', async () => {
    const { fetchImpl, calls } = fakeFetch({ result: enabledToWorker });
    const result = await checkEmailRoutingDrift({
      token: 'token-value',
      zoneId: 'zone-1',
      fetchImpl,
    });
    expect(result).toEqual({
      drifted: false,
      enabled: true,
      namesWorker: true,
      actionTypes: ['worker'],
    });
    expect(calls[0].url).toBe(ROUTING_URL);
    expect(calls[0].init.headers.Authorization).toBe('Bearer token-value');
  });

  test('accepts a worker action whose value is a single name rather than a list', async () => {
    const { fetchImpl } = fakeFetch({
      result: { enabled: true, actions: [{ type: 'worker', value: 'mail-app-ingest' }] },
    });
    const result = await checkEmailRoutingDrift({ token: 't', zoneId: 'zone-1', fetchImpl });
    expect(result.drifted).toBe(false);
  });

  test.each([
    [
      'a disabled rule',
      { enabled: false, actions: [{ type: 'worker', value: ['mail-app-ingest'] }] },
    ],
    [
      'a worker action for another Worker',
      { enabled: true, actions: [{ type: 'worker', value: ['some-other-worker'] }] },
    ],
    [
      'a forward action only',
      { enabled: true, actions: [{ type: 'forward', value: ['owner@example.com'] }] },
    ],
    ['no rule at all', null],
  ])('reports drift for %s', async (_label, result) => {
    const { fetchImpl } = fakeFetch({ result });
    const check = await checkEmailRoutingDrift({ token: 't', zoneId: 'zone-1', fetchImpl });
    expect(check.drifted).toBe(true);
  });

  test('returns action types only, never values that can name the owner mailbox', async () => {
    const { fetchImpl } = fakeFetch({
      result: { enabled: true, actions: [{ type: 'forward', value: ['owner@example.com'] }] },
    });
    const check = await checkEmailRoutingDrift({ token: 't', zoneId: 'zone-1', fetchImpl });
    expect(check.actionTypes).toEqual(['forward']);
    expect(JSON.stringify(check)).not.toContain('owner@example.com');
  });

  test('throws when the API refuses the request', async () => {
    /** @type {typeof fetch} */
    const fetchImpl = async () => new Response('{"success":false}', { status: 403 });
    await expect(
      checkEmailRoutingDrift({ token: 'token-value', zoneId: 'zone-1', fetchImpl }),
    ).rejects.toThrow('responded 403');
  });
});

describe('runInboundHealthChecks', () => {
  const env = /** @type {any} */ ({
    HYPERDRIVE: { connectionString: 'postgres://user:secret@example/db' },
    OWNER_EMAIL: 'owner@example.com',
  });

  /** @returns {{reports: any[], failures: any[]}} */
  const collectors = () => ({ reports: [], failures: [] });

  test('reports a stale feed and a pending backlog, each under its own condition', async () => {
    const { reports, failures } = collectors();
    await runInboundHealthChecks(env, {
      createSql: healthSql({
        newest: new Date('2026-10-25T00:00:00Z'),
        pending: 3,
        oldest: new Date('2026-10-26T10:00:00Z'),
      }),
      now: NOW,
      fetchImpl: async () => {
        throw new Error('routing must be skipped without a token');
      },
      report: (condition, message, extra) => reports.push({ condition, message, extra }),
      reportFailure: (operation, /** @type {any} */ err, secrets, extra) =>
        failures.push({ operation, message: err.message, secrets, extra }),
    });
    expect(failures).toEqual([]);
    expect(reports.map((report) => report.condition)).toEqual([
      'stale-inbound',
      'pending-enrichment',
    ]);
    expect(reports[0].extra).toEqual({ age_hours: 36, threshold_hours: 12 });
    expect(reports[1].extra).toEqual({
      pending_count: 3,
      oldest_age_minutes: 120,
      threshold_minutes: 60,
    });
    // The owner's address is personal data and never reaches a report.
    expect(JSON.stringify(reports)).not.toContain('owner@example.com');
  });

  test('stays silent when inbound mail is fresh and nothing is pending', async () => {
    const { reports, failures } = collectors();
    await runInboundHealthChecks(env, {
      createSql: healthSql({ newest: NOW, pending: 0 }),
      now: NOW,
      fetchImpl: async () => new Response('{}'),
      report: (condition, message, extra) => reports.push({ condition, message, extra }),
      reportFailure: (operation, /** @type {any} */ err, secrets, extra) =>
        failures.push({ operation, message: err.message, secrets, extra }),
    });
    expect(reports).toEqual([]);
    expect(failures).toEqual([]);
  });

  test('reports a failed check and still runs the others, without throwing', async () => {
    const { reports, failures } = collectors();
    const createSql = () => {
      /** @type {any} */
      const sql = async (/** @type {TemplateStringsArray} */ strings) => {
        const text = strings.join('?');
        if (text.includes('max(m.created_at)')) throw new Error('connection refused');
        if (text.includes('count(*)')) {
          return [{ pending: 1, oldest: new Date('2026-10-26T11:00:00Z') }];
        }
        return [];
      };
      sql.end = async () => undefined;
      return sql;
    };
    await expect(
      runInboundHealthChecks(env, {
        createSql,
        now: NOW,
        fetchImpl: async () => new Response('{}'),
        report: (condition, message, extra) => reports.push({ condition, message, extra }),
        reportFailure: (operation, /** @type {any} */ err, secrets, extra) =>
          failures.push({ operation, message: err.message, secrets, extra }),
      }),
    ).resolves.toBeUndefined();
    expect(failures).toEqual([
      {
        operation: 'inbound_health',
        message: 'connection refused',
        secrets: [env.HYPERDRIVE.connectionString],
        extra: { check: 'stale_inbound' },
      },
    ]);
    expect(reports.map((report) => report.condition)).toEqual(['pending-enrichment']);
  });

  test('reports routing drift under its own condition and never includes the token', async () => {
    const { reports, failures } = collectors();
    const token = 'cf-token-secret-value';
    const { fetchImpl } = fakeFetch({ result: { enabled: false, actions: [] } });
    await runInboundHealthChecks(
      { ...env, CLOUDFLARE_EMAIL_ROUTING_TOKEN: token, EMAIL_ROUTING_ZONE_ID: 'zone-1' },
      {
        createSql: healthSql({ newest: NOW, pending: 0 }),
        now: NOW,
        fetchImpl,
        report: (condition, message, extra) => reports.push({ condition, message, extra }),
        reportFailure: (operation, /** @type {any} */ err, secrets, extra) =>
          failures.push({ operation, message: err.message, secrets, extra }),
      },
    );
    expect(failures).toEqual([]);
    expect(reports.map((report) => report.condition)).toEqual(['email-routing-drift']);
    expect(reports[0].extra).toEqual({ enabled: false, names_worker: false, action_types: '' });
    expect(JSON.stringify(reports)).not.toContain(token);
  });

  test('reports an unreadable routing API as a failure, redacting the token', async () => {
    const { reports, failures } = collectors();
    const token = 'cf-token-secret-value';
    /** @type {typeof fetch} */
    const fetchImpl = async () => new Response('{"success":false}', { status: 500 });
    await runInboundHealthChecks(
      { ...env, CLOUDFLARE_EMAIL_ROUTING_TOKEN: token, EMAIL_ROUTING_ZONE_ID: 'zone-1' },
      {
        createSql: healthSql({ newest: NOW, pending: 0 }),
        now: NOW,
        fetchImpl,
        report: (condition, message, extra) => reports.push({ condition, message, extra }),
        reportFailure: (operation, /** @type {any} */ err, secrets, extra) =>
          failures.push({ operation, message: err.message, secrets, extra }),
      },
    );
    expect(reports).toEqual([]);
    expect(failures).toEqual([
      {
        operation: 'inbound_health',
        message: 'Cloudflare email routing API responded 500',
        secrets: [env.HYPERDRIVE.connectionString, token],
        extra: { check: 'email_routing' },
      },
    ]);
  });

  test('skips the routing check without a token and without calling the API', async () => {
    const { reports, failures } = collectors();
    await runInboundHealthChecks(env, {
      createSql: healthSql({ newest: NOW, pending: 0 }),
      now: NOW,
      fetchImpl: async () => {
        throw new Error('routing must not be called without a token');
      },
      report: (condition, message, extra) => reports.push({ condition, message, extra }),
      reportFailure: (operation, /** @type {any} */ err, secrets, extra) =>
        failures.push({ operation, message: err.message, secrets, extra }),
    });
    expect(reports).toEqual([]);
    expect(failures).toEqual([]);
  });
});
