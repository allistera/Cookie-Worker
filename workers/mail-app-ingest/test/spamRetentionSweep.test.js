import { afterEach, describe, expect, it, vi } from 'vitest';

const { captureHandledException } = vi.hoisted(() => ({ captureHandledException: vi.fn() }));
vi.mock('../src/sentry.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, captureHandledException };
});

import { PURGE_LIMIT, purgeExpiredSpam } from '../src/spamRetentionSweep.js';

const ENV = { HYPERDRIVE: { connectionString: 'postgres://user:pass@example/db' } };
const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';

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
  afterEach(() => {
    vi.useRealTimers();
  });

  // The socket to Hyperdrive dropped under this sweep on the Sep 9 cron
  // (Sentry COOKIE-WEB-12). The statement is idempotent, so it gets a fresh
  // client and another go.
  it('retries a dropped connection on a fresh client', async () => {
    vi.useFakeTimers();
    captureHandledException.mockClear();
    const first = createMockSql();
    first.mockRejectedValueOnce(new Error('Network connection lost.'));
    const second = createMockSql([[{ id: ID_1, screening_status: 'allowed' }]]);
    const createSql = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const purge = purgeExpiredSpam(ENV, { createSql });
    await vi.advanceTimersByTimeAsync(1000);
    await purge;

    expect(createSql).toHaveBeenCalledTimes(2);
    expect(first.end).toHaveBeenCalledOnce();
    expect(second.end).toHaveBeenCalledOnce();
    expect(captureHandledException).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'spam_purged', deleted: 1, blocked: 0 }),
    );
    log.mockRestore();
  });

  it('soft-deletes spam past its owner’s retention, bounded per tick, and closes its client', async () => {
    const sql = createMockSql([[{ id: ID_1, screening_status: 'allowed' }]]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await purgeExpiredSpam(ENV, { createSql: () => sql });

    const { text, values } = sql.calls[0];
    const spam = text.slice(text.indexOf('FROM message_ai ai'), text.indexOf('UNION ALL'));
    expect(spam).toContain("ai.spam_verdict = 'spam'");
    // Only what the Spam folder lists: spam moved to Done is kept.
    expect(spam).toContain('NOT m.is_deleted AND NOT m.is_archived AND NOT m.is_sent');
    expect(spam).toContain("m.screening_status = 'allowed'");
    // The clock starts when the verdict landed, not when the mail arrived.
    expect(spam).toContain('COALESCE(ai.processed_at, m.created_at) < r.cutoff');
    // The stored preference is bounded in SQL too, and read only as a number.
    expect(text).toContain("jsonb_typeof(u.prefs -> 'spamRetentionDays') = 'number'");
    expect(text).toContain('LEAST(365, GREATEST(1,');
    // The same delete the reader uses, plus the search drift marker.
    expect(text).toContain('SET is_deleted = true, search_indexed_at = NULL');
    expect(values).toEqual([30, PURGE_LIMIT]);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'spam_purged', deleted: 1, blocked: 0 }),
    );
    expect(sql.end).toHaveBeenCalled();
    log.mockRestore();
  });

  it('soft-deletes blocked mail on the same retention, counted from the block', async () => {
    const sql = createMockSql([
      [
        { id: ID_1, screening_status: 'blocked' },
        { id: ID_2, screening_status: 'allowed' },
      ],
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await purgeExpiredSpam(ENV, { createSql: () => sql });

    const { text } = sql.calls[0];
    const blocked = text.slice(text.indexOf('UNION ALL'), text.indexOf('ORDER BY since'));
    // What the Blocked folder lists, whatever its archive or spam state. Mail
    // held in New senders is never a candidate.
    expect(blocked).toContain("m.screening_status = 'blocked'");
    expect(blocked).toContain('NOT m.is_deleted AND NOT m.is_sent');
    expect(blocked).not.toContain('is_archived');
    expect(text).not.toContain("'held'");
    // Mail that moved into Blocked with the decision counts from the decision.
    expect(blocked).toContain('GREATEST(m.created_at, sd.updated_at) < r.cutoff');
    // Candidate selection is a snapshot; after waiting for a concurrent Block
    // or Unblock the UPDATE target must recheck the committed disposition.
    expect(text.slice(text.indexOf('UPDATE messages m'))).toContain(
      'WHERE m.id = expired.id AND m.screening_status = expired.screening_status',
    );
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'spam_purged', deleted: 2, blocked: 1 }),
    );
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
