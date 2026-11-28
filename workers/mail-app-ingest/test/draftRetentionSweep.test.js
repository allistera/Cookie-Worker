import { afterEach, describe, expect, it, vi } from 'vitest';

const { captureHandledException } = vi.hoisted(() => ({ captureHandledException: vi.fn() }));
vi.mock('../src/sentry.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, captureHandledException };
});

import {
  DRAFT_RETENTION_DAYS,
  PURGE_LIMIT,
  purgeExpiredDrafts,
} from '../src/draftRetentionSweep.js';

const ENV = { HYPERDRIVE: { connectionString: 'postgres://user:pass@example/db' } };
const ID_1 = '11111111-1111-4111-8111-111111111111';

/** @param {() => Promise<unknown[]>} answer */
function createMockSql(answer = async () => []) {
  /** @type {{text: string, values: unknown[]}[]} */
  const calls = [];
  /** @type {any} */
  const sql = vi.fn((/** @type {any} */ strings, /** @type {unknown[]} */ ...values) => {
    calls.push({ text: strings.join('?'), values });
    return answer();
  });
  sql.calls = calls;
  sql.end = vi.fn().mockResolvedValue(undefined);
  return sql;
}

describe('purgeExpiredDrafts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    captureHandledException.mockClear();
  });

  it('deletes unstarred drafts after 30 days, bounded per tick, and closes its client', async () => {
    const sql = createMockSql(async () => [{ id: ID_1 }]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await purgeExpiredDrafts(ENV, { createSql: () => sql });

    expect(DRAFT_RETENTION_DAYS).toBe(30);
    const { text, values } = sql.calls[0];
    const removal = text.slice(text.indexOf('DELETE FROM drafts d'));
    // Both tests are repeated on the row being deleted, for a concurrent star.
    expect(removal).toContain('NOT d.is_starred');
    expect(removal).toContain('GREATEST(d.updated_at, d.retention_from)');
    expect(values).toEqual([DRAFT_RETENTION_DAYS, PURGE_LIMIT, DRAFT_RETENTION_DAYS]);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'drafts_purged', deleted: 1 }));
    expect(sql.end).toHaveBeenCalled();
  });

  it('says nothing when no draft has expired', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await purgeExpiredDrafts(ENV, { createSql: () => createMockSql() });

    expect(log).not.toHaveBeenCalled();
  });

  it('reports a failure without failing the cron tick', async () => {
    const sql = createMockSql(async () => {
      throw new Error('boom');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(purgeExpiredDrafts(ENV, { createSql: () => sql })).resolves.toBeUndefined();

    expect(captureHandledException).toHaveBeenCalledWith('draft_purge', expect.any(Error), [
      ENV.HYPERDRIVE.connectionString,
    ]);
    expect(sql.end).toHaveBeenCalled();
  });

  it('logs a missing database client instead of throwing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await purgeExpiredDrafts(ENV);

    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'draft_purge_misconfigured' }));
  });
});
