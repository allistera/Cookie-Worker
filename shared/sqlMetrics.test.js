import { describe, expect, it, vi } from 'vitest';
import {
  MAX_QUERY_POINTS,
  entryName,
  recordQuery,
  runWithSqlMetrics,
  sqlMetricsScope,
  withSqlMetrics,
} from './sqlMetrics.js';

const ctx = /** @type {any} */ ({ waitUntil: () => undefined });

/** @returns {any} */
function metricsEnv() {
  return { SQL_METRICS: { writeDataPoint: vi.fn() } };
}

describe('entryName', () => {
  it('names a request by its method and route template', () => {
    const request = new Request(
      'https://worker.example/messages/7f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f0a1b?token=secret',
      { method: 'DELETE' },
    );
    expect(entryName('fetch', request)).toBe('DELETE /messages/{id}');
  });

  it('names a cron tick by its schedule and other triggers by themselves', () => {
    expect(entryName('scheduled', { cron: '*/15 * * * *' })).toBe('scheduled */15 * * * *');
    expect(entryName('scheduled', {})).toBe('scheduled');
    expect(entryName('email', { from: 'someone@example.com' })).toBe('email');
    expect(entryName('queue', { queue: 'jobs' })).toBe('queue');
    expect(entryName('fetch', { url: 'not a url', method: 'GET' })).toBe('fetch');
  });
});

describe('withSqlMetrics', () => {
  it('opens a scope for each handler, naming the service and what the invocation is', async () => {
    /** @type {any[]} */
    const seen = [];
    const env = metricsEnv();
    const remember = async () => {
      // The scope has to survive the awaits between a handler and its queries.
      await Promise.resolve();
      seen.push({ ...sqlMetricsScope() });
      return new Response();
    };
    const worker = withSqlMetrics(
      { fetch: remember, scheduled: remember, email: remember, queue: remember },
      'cookie-web-messages',
    );

    await worker.fetch(new Request('https://worker.example/messages/42'), env, ctx);
    await worker.scheduled({ cron: '0 * * * *' }, env, ctx);
    await worker.email({}, env, ctx);
    await worker.queue({}, env, ctx);

    expect(seen.map(({ service, entry, written }) => ({ service, entry, written }))).toEqual([
      { service: 'cookie-web-messages', entry: 'GET /messages/{id}', written: 0 },
      { service: 'cookie-web-messages', entry: 'scheduled 0 * * * *', written: 0 },
      { service: 'cookie-web-messages', entry: 'email', written: 0 },
      { service: 'cookie-web-messages', entry: 'queue', written: 0 },
    ]);
    expect(seen.every((scope) => scope.dataset === env.SQL_METRICS)).toBe(true);
    expect(sqlMetricsScope()).toBeUndefined();
  });

  it('keeps concurrent invocations apart', async () => {
    const env = metricsEnv();
    /** @type {string[]} */
    const entries = [];
    const worker = withSqlMetrics(
      {
        async fetch() {
          await new Promise((resolve) => setTimeout(resolve, 1));
          entries.push(sqlMetricsScope()?.entry ?? 'none');
          return new Response();
        },
      },
      'svc',
    );

    await Promise.all([
      worker.fetch(new Request('https://worker.example/a'), env, ctx),
      worker.fetch(new Request('https://worker.example/b'), env, ctx),
    ]);

    expect(entries.toSorted()).toEqual(['GET /a', 'GET /b']);
  });

  it('runs the handler without a scope when the dataset is not bound', async () => {
    const fetch = vi.fn(async () => {
      expect(sqlMetricsScope()).toBeUndefined();
      return new Response(null, { status: 204 });
    });
    const request = new Request('https://worker.example/messages');
    const env = /** @type {any} */ ({});

    const response = await withSqlMetrics({ fetch }, 'svc').fetch(request, env, ctx);

    expect(response.status).toBe(204);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request, env, ctx);
  });

  it('lets a handler failure through and preserves everything else on the worker', async () => {
    const helper = () => 'kept';
    const worker = withSqlMetrics(
      {
        helper,
        async scheduled() {
          throw new Error('boom');
        },
      },
      'svc',
    );

    expect(worker.helper).toBe(helper);
    expect(worker.fetch).toBeUndefined();
    await expect(worker.scheduled({}, metricsEnv(), ctx)).rejects.toThrow('boom');
  });
});

describe('runWithSqlMetrics', () => {
  it('scopes work that starts outside a wrapped handler', async () => {
    const env = metricsEnv();
    const scope = await runWithSqlMetrics(env, 'cookie-web-send', 'alarm', async () =>
      sqlMetricsScope(),
    );
    expect(scope).toMatchObject({ service: 'cookie-web-send', entry: 'alarm', written: 0 });
    expect(runWithSqlMetrics(undefined, 'svc', 'alarm', () => sqlMetricsScope())).toBeUndefined();
  });
});

describe('recordQuery', () => {
  const query = {
    operation: 'SELECT',
    fingerprint: '0a1b2c3d',
    outcome: 'ok',
    durationMs: 12,
    rows: 3,
  };

  it('writes the service, entry, operation, fingerprint and outcome with the duration and rows', () => {
    const writeDataPoint = vi.fn();
    const scope = { dataset: { writeDataPoint }, service: 'svc', entry: 'GET /a', written: 0 };

    recordQuery(scope, query);

    expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
      indexes: ['svc'],
      blobs: ['svc', 'GET /a', 'SELECT', '0a1b2c3d', 'ok'],
      doubles: [12, 3],
    });
    expect(scope.written).toBe(1);
  });

  it('stops at the per-invocation limit', () => {
    const writeDataPoint = vi.fn();
    const scope = { dataset: { writeDataPoint }, service: 'svc', entry: 'email', written: 0 };

    for (let index = 0; index < MAX_QUERY_POINTS + 25; index += 1) recordQuery(scope, query);

    expect(writeDataPoint).toHaveBeenCalledTimes(MAX_QUERY_POINTS);
    expect(MAX_QUERY_POINTS).toBeLessThan(250);
  });

  it('swallows a failing write', () => {
    const scope = {
      dataset: {
        writeDataPoint() {
          throw new Error('Analytics Engine unavailable');
        },
      },
      service: 'svc',
      entry: 'queue',
      written: 0,
    };
    expect(() => recordQuery(scope, query)).not.toThrow();
  });
});
