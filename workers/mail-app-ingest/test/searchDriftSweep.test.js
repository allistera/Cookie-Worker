import { afterEach, describe, expect, it, vi } from 'vitest';

const { captureHandledException } = vi.hoisted(() => ({ captureHandledException: vi.fn() }));
vi.mock('../src/sentry.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, captureHandledException };
});

import {
  SWEEP_LIMIT,
  WORKSPACE_SWEEP_LIMIT,
  sweepSearchDrift,
  sweepWorkspaceSearchDrift,
} from '../src/searchDriftSweep.js';

const ENV = {
  HYPERDRIVE: { connectionString: 'postgres://user:pass@example/db' },
  MEILISEARCH_URL: 'https://meili.test',
  MEILISEARCH_API_KEY: 'key',
};

const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';

describe('bounded workspace search repair', () => {
  it('retries documents and child task edits, stamping only after successful indexing', async () => {
    const document = { id: ID_1, row_version: '7', updated_at: new Date(0), title: 'Changed' };
    const task = {
      id: ID_2,
      row_version: '8',
      child_versions: 'child:9',
      updated_at: new Date(0),
      subtasks: ['Edited child'],
    };
    const docsSql = createMockSql([[document], []]);
    const tasksSql = createMockSql([[task], []]);
    const createSql = vi.fn().mockReturnValueOnce(docsSql).mockReturnValueOnce(tasksSql);
    const add = vi.fn(async (_env, descriptor) => {
      const client = descriptor.name === 'documents' ? docsSql : tasksSql;
      // There has been no optimistic stamp when the index request begins.
      expect(client.calls).toHaveLength(1);
      return { taskUid: 1, status: 'succeeded' };
    });
    await sweepWorkspaceSearchDrift(ENV, { createSql, add });
    expect(add.mock.calls.map((call) => call[1].name)).toEqual(['documents', 'task_items']);
    expect(docsSql.mock.calls[0].slice(1)).toEqual([WORKSPACE_SWEEP_LIMIT]);
    expect(tasksSql.mock.calls[0].slice(1)).toEqual([WORKSPACE_SWEEP_LIMIT]);
    expect(docsSql.calls[1].text).toContain('t.xmin::text = v.row_version');
    expect(tasksSql.calls[1].text).toContain('= v.child_versions');
    expect(tasksSql.mock.calls[1].slice(1)).toContainEqual(['child:9']);
    expect(docsSql.end).toHaveBeenCalledOnce();
    expect(tasksSql.end).toHaveBeenCalledOnce();
  });

  it('keeps failed documents dirty while continuing task recovery', async () => {
    const docsSql = createMockSql([[{ id: ID_1, row_version: '1', updated_at: new Date(0) }]]);
    const tasksSql = createMockSql([
      [{ id: ID_2, row_version: '2', updated_at: new Date(0), child_versions: '' }],
      [],
    ]);
    const createSql = vi.fn().mockReturnValueOnce(docsSql).mockReturnValueOnce(tasksSql);
    const add = vi
      .fn()
      .mockRejectedValueOnce(new Error('Index task failed'))
      .mockResolvedValueOnce(undefined);
    await sweepWorkspaceSearchDrift(ENV, { createSql, add });
    expect(docsSql.calls).toHaveLength(1);
    expect(tasksSql.calls).toHaveLength(2);
    expect(add).toHaveBeenCalledTimes(2);
  });
});

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
    const sync = vi
      .fn()
      .mockResolvedValue({ indexed: 1, failed: 1, error: 'Request failed with status 530' });

    await sweepSearchDrift(ENV, { createSql: () => sql, sync });

    expect(captureHandledException).toHaveBeenCalledOnce();
    // The underlying cause travels with the alert, so it can be diagnosed
    // from Sentry alone.
    expect(captureHandledException.mock.calls[0][3]).toMatchObject({
      indexed: 1,
      failed: 1,
      error: 'Request failed with status 530',
    });
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
