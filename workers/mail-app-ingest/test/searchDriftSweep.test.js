import { describe, expect, it, vi } from 'vitest';
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
  it('does nothing when Meilisearch is not configured', async () => {
    const createSql = vi.fn();
    const sync = vi.fn();

    await sweepSearchDrift({ HYPERDRIVE: ENV.HYPERDRIVE }, { createSql, sync });

    expect(createSql).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it('reindexes the drifted rows it finds and closes its own client', async () => {
    const sql = createMockSql([[{ id: ID_1 }, { id: ID_2 }]]);
    const sync = vi.fn().mockResolvedValue(undefined);

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

    await sweepSearchDrift(ENV, { createSql: () => sql, sync: vi.fn() });

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

  // A failed sweep must never surface as a failed cron invocation.
  it('swallows a reindex failure and still closes its client', async () => {
    const sql = createMockSql([[{ id: ID_1 }]]);
    const sync = vi.fn().mockRejectedValue(new Error('meili down'));

    await expect(sweepSearchDrift(ENV, { createSql: () => sql, sync })).resolves.toBeUndefined();
    expect(sql.end).toHaveBeenCalled();
  });
});
