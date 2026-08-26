import { describe, expect, test, vi } from 'vitest';
import { allowRequest } from './rate-limit.js';

// Ported from Cookie-Web's api/_lib/__tests__/rate-limit.test.js.

/** @param {{allowed: boolean}} row @returns {any} */
function sqlReturning(row) {
  /** @type {any} */
  const sql = vi.fn(
    (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => {
      sql.query = strings.join('?');
      sql.values = values;
      return Promise.resolve([row]);
    },
  );
  return sql;
}

describe('allowRequest', () => {
  test('claims a shared database counter with one atomic upsert', async () => {
    const sql = sqlReturning({ allowed: true });

    await expect(
      allowRequest(sql, '11111111-1111-4111-8111-111111111111', 'ai', {
        limit: 10,
        windowMs: 60_000,
      }),
    ).resolves.toBe(true);

    expect(sql.query).toContain('INSERT INTO api_rate_limits');
    expect(sql.query).toContain('ON CONFLICT (user_id, scope) DO UPDATE');
    expect(sql.query).toContain('api_rate_limits.request_count <');
    expect(sql.values).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'ai',
      60_000,
      60_000,
      60_000,
      10,
    ]);
  });

  test('rejects when the shared counter cannot be claimed', async () => {
    const sql = sqlReturning({ allowed: false });

    await expect(
      allowRequest(sql, '11111111-1111-4111-8111-111111111111', 'ai', {
        limit: 10,
        windowMs: 60_000,
      }),
    ).resolves.toBe(false);
  });

  test('fails closed on invalid policy values without querying the database', async () => {
    const sql = vi.fn();

    await expect(
      allowRequest(/** @type {any} */ (sql), '11111111-1111-4111-8111-111111111111', 'ai', {
        limit: 0,
        windowMs: 60_000,
      }),
    ).rejects.toThrow(/invalid rate-limit policy/i);
    expect(sql).not.toHaveBeenCalled();
  });
});
