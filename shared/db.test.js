import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createSql, endSql, withUserSql } from './db.js';
import { runAsInternalCaller } from './internal-identity.js';

vi.mock('postgres', () => ({ default: vi.fn() }));

function client() {
  const sql = /** @type {any} */ (vi.fn());
  sql.end = vi.fn().mockRejectedValue(new Error('socket already closed'));
  return sql;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('database lifecycle', () => {
  it.each([null, undefined])('allows cleanup without a client: %s', async (sql) => {
    await expect(endSql(sql)).resolves.toBeUndefined();
  });

  it('does not let failed cleanup mask the caller result', async () => {
    const sql = client();
    await expect(endSql(sql)).resolves.toBeUndefined();
    expect(sql.end).toHaveBeenCalledWith({ timeout: 2 });
  });

  it('replaces connection parser errors with a credential-free message', () => {
    vi.mocked(postgres).mockImplementation(() => {
      throw new Error('invalid connection configuration');
    });
    expect(() => createSql('invalid')).toThrow('database connection string is not valid');
  });

  it('uses a fresh client on retry and tolerates cleanup failure on both clients', async () => {
    vi.useFakeTimers();
    const first = client();
    const second = client();
    vi.mocked(postgres).mockReturnValueOnce(first).mockReturnValueOnce(second);
    const waitUntil = vi.fn();
    // This handler only schedules cleanup; other runtime context APIs are unused.
    const ctx = /** @type {any} */ ({ waitUntil });
    const response = new Response('ok');
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network connection lost'))
      .mockResolvedValueOnce(response);
    const pending = runAsInternalCaller({ userId: 'user-1', email: 'user@example.com' }, () =>
      withUserSql(
        new Request('https://example.invalid/messages'),
        { HYPERDRIVE: { connectionString: 'postgres://localhost/test' } },
        ctx,
        { retryable: true },
        handle,
      ),
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe(response);
    expect(handle).toHaveBeenNthCalledWith(1, first, 'user-1', 1);
    expect(handle).toHaveBeenNthCalledWith(2, second, 'user-1', 2);
    expect(first.end).toHaveBeenCalledOnce();
    expect(second.end).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledTimes(2);
    await expect(Promise.all(waitUntil.mock.calls.map(([promise]) => promise))).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
