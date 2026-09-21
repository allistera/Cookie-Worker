import { afterEach, describe, expect, it, vi } from 'vitest';

const { captureHandledException } = vi.hoisted(() => ({ captureHandledException: vi.fn() }));
vi.mock('../src/sentry.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, captureHandledException };
});

import { SWEEP_LIMIT, sweepSearchDrift } from '../src/searchDriftSweep.js';

const ENV = {
  HYPERDRIVE: { connectionString: 'postgres://user:pass@example/db' },
  MEILISEARCH_URL: 'https://meili.test',
  MEILISEARCH_API_KEY: 'key',
};

const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';

/**
 * Minimal postgres.js-shaped tagged-template mock, matching the createMockSql
 * pattern the other workers' tests use.
 * @param {unknown[][]} results
 */
function createMockSql(results = []) {
  const queue = [...results];
  /** @type {{text: string}[]} */
  const calls = [];
  /** @type {any} */
  const sql = vi.fn((/** @type {any} */ strings) => {
    calls.push({ text: strings.join('?') });
    return Promise.resolve(queue.length ? queue.shift() : []);
  });
  sql.calls = calls;
  sql.end = vi.fn().mockResolvedValue(undefined);
  return sql;
}

describe('sweepSearchDrift', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The socket to Hyperdrive dropped under this sweep on the Sep 9 cron
  // (Sentry COOKIE-WEB-10). Reindexing is idempotent, so it gets a fresh
  // client and another go.
  it('retries a dropped connection on a fresh client', async () => {
    vi.useFakeTimers();
    captureHandledException.mockClear();
    const first = createMockSql();
    first.mockRejectedValueOnce(new Error('Network connection lost.'));
    const second = createMockSql([[{ id: ID_1 }]]);
    const createSql = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const sync = vi.fn().mockResolvedValue({ indexed: 1, failed: 0 });

    const sweep = sweepSearchDrift(ENV, { createSql, sync });
    await vi.advanceTimersByTimeAsync(1000);
    await sweep;

    expect(createSql).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledExactlyOnceWith(second, ENV, [ID_1]);
    expect(first.end).toHaveBeenCalledOnce();
    expect(second.end).toHaveBeenCalledOnce();
    expect(captureHandledException).not.toHaveBeenCalled();
  });

  it('does nothing when Meilisearch is not configured', async () => {
    const createSql = vi.fn();
    const sync = vi.fn();

    await sweepSearchDrift({ HYPERDRIVE: ENV.HYPERDRIVE }, { createSql, sync });

    expect(createSql).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('reindexes the drifted rows it finds and closes its own client', async () => {
    const sql = createMockSql([[{ id: ID_1 }, { id: ID_2 }]]);
    const sync = vi.fn().mockResolvedValue({ indexed: 2, failed: 0 });

    await sweepSearchDrift(ENV, { createSql: () => sql, sync });

    expect(sql.calls[0].text).toContain('search_indexed_at IS NULL');
    expect(sync).toHaveBeenCalledWith(sql, ENV, [ID_1, ID_2]);
    expect(sql.end).toHaveBeenCalled();
  });

  // The partial index from migration 0055 is (created_at) WHERE
  // search_indexed_at IS NULL, so the sweep must order by created_at for
  // Postgres to use it.
  it('orders by created_at so the drift index is usable, and bounds the batch', async () => {
    const sql = createMockSql([[{ id: ID_1 }]]);

    await sweepSearchDrift(ENV, {
      createSql: () => sql,
      sync: vi.fn().mockResolvedValue({ indexed: 1, failed: 0 }),
    });

    expect(sql.calls[0].text).toContain('ORDER BY created_at DESC');
    expect(sql.calls[0].text).toContain('LIMIT');
    expect(SWEEP_LIMIT).toBeGreaterThan(0);
  });

  it('skips the reindex entirely when nothing has drifted', async () => {
    const sql = createMockSql([[]]);
    const sync = vi.fn();

    await sweepSearchDrift(ENV, { createSql: () => sql, sync });

    expect(sync).not.toHaveBeenCalled();
    expect(sql.end).toHaveBeenCalled();
  });

  // The sync swallows its own errors and resolves, so the counts it returns —
  // not the absence of a throw — are the only signal that a tick did nothing.
  it('reports and alerts when rows could not be reindexed', async () => {
    captureHandledException.mockClear();
    const sql = createMockSql([[{ id: ID_1 }, { id: ID_2 }]]);
    const sync = vi.fn().mockResolvedValue({ indexed: 1, failed: 1 });

    await sweepSearchDrift(ENV, { createSql: () => sql, sync });

    expect(captureHandledException).toHaveBeenCalledOnce();
    expect(captureHandledException.mock.calls[0][3]).toMatchObject({ indexed: 1, failed: 1 });
  });

  it('does not alert when every drifted row was reindexed', async () => {
    captureHandledException.mockClear();
    const sql = createMockSql([[{ id: ID_1 }]]);

    await sweepSearchDrift(ENV, {
      createSql: () => sql,
      sync: vi.fn().mockResolvedValue({ indexed: 1, failed: 0 }),
    });

    expect(captureHandledException).not.toHaveBeenCalled();
  });

  // createSql throws on a bad connection string; this runs under waitUntil
  // next to enrichment recovery, so a rejection would be unhandled.
  it('does not reject when the database client cannot be created', async () => {
    const createSql = () => {
      throw new Error('database connection string is not valid');
    };

    await expect(sweepSearchDrift(ENV, { createSql, sync: vi.fn() })).resolves.toBeUndefined();
  });

  // A failed sweep must never surface as a failed cron invocation.
  it('swallows a reindex failure and still closes its client', async () => {
    const sql = createMockSql([[{ id: ID_1 }]]);
    const sync = vi.fn().mockRejectedValue(new Error('meili down'));

    await expect(sweepSearchDrift(ENV, { createSql: () => sql, sync })).resolves.toBeUndefined();
    expect(sql.end).toHaveBeenCalled();
  });
});
