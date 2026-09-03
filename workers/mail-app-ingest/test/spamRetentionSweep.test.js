import { describe, expect, it, vi } from 'vitest';

const { captureHandledException } = vi.hoisted(() => ({ captureHandledException: vi.fn() }));
vi.mock('../src/sentry.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, captureHandledException };
});

import { PURGE_LIMIT, purgeExpiredSpam } from '../src/spamRetentionSweep.js';

const ENV = { HYPERDRIVE: { connectionString: 'postgres://user:pass@example/db' } };
const ID_1 = '11111111-1111-4111-8111-111111111111';

/** @param {unknown[][]} results */
function createMockSql(results = []) {
  const queue = [...results];
  /** @type {{text: string, values: unknown[]}[]} */
  const calls = [];
  /** @type {any} */
  const sql = vi.fn((/** @type {any} */ strings, /** @type {unknown[]} */ ...values) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(queue.length ? queue.shift() : []);
  });
  sql.calls = calls;
  sql.end = vi.fn().mockResolvedValue(undefined);
  return sql;
}

describe('purgeExpiredSpam', () => {
  it('soft-deletes spam past its owner’s retention, bounded per tick, and closes its client', async () => {
    const sql = createMockSql([[{ id: ID_1 }]]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await purgeExpiredSpam(ENV, { createSql: () => sql });

    const { text, values } = sql.calls[0];
    expect(text).toContain("ai.spam_verdict = 'spam'");
    expect(text).toContain('NOT m.is_deleted');
    // The clock starts when the verdict landed, not when the mail arrived.
    expect(text).toContain('COALESCE(ai.processed_at, m.created_at) < now() - make_interval');
    // The stored preference is bounded in SQL too, and read only as a number.
    expect(text).toContain("jsonb_typeof(u.prefs -> 'spamRetentionDays') = 'number'");
    expect(text).toContain('LEAST(365, GREATEST(1,');
    // The same delete the reader uses, plus the search drift marker.
    expect(text).toContain('SET is_deleted = true, search_indexed_at = NULL');
    expect(values).toEqual([30, PURGE_LIMIT]);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'spam_purged', deleted: 1 }));
    expect(sql.end).toHaveBeenCalled();
    log.mockRestore();
  });

  it('stays quiet on a tick that finds nothing', async () => {
    const sql = createMockSql([[]]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await purgeExpiredSpam(ENV, { createSql: () => sql });

    expect(log).not.toHaveBeenCalled();
    expect(sql.end).toHaveBeenCalled();
    log.mockRestore();
  });

  it('reports a failed sweep without throwing, so the cron tick survives', async () => {
    const sql = createMockSql();
    sql.mockRejectedValueOnce(new Error('connection reset'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(purgeExpiredSpam(ENV, { createSql: () => sql })).resolves.toBeUndefined();

    expect(captureHandledException).toHaveBeenCalledWith('spam_purge', expect.any(Error), [
      ENV.HYPERDRIVE.connectionString,
    ]);
    expect(sql.end).toHaveBeenCalled();
    log.mockRestore();
  });

  it('logs rather than throws when no sql factory is injected', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await purgeExpiredSpam(ENV);

    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'spam_purge_misconfigured' }));
    log.mockRestore();
  });
});
