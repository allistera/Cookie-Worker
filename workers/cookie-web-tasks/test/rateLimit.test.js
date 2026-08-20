import { describe, expect, it } from 'vitest';
import { allowRequest } from '../src/rateLimit.js';
import { createMockSql } from './helpers.js';

describe('allowRequest', () => {
  it('claims a shared database counter with one atomic upsert', async () => {
    const sql = createMockSql([[{ allowed: true }]]);

    await expect(
      allowRequest(sql, '11111111-1111-4111-8111-111111111111', 'ai', { limit: 10, windowMs: 60_000 }),
    ).resolves.toBe(true);

    expect(sql.calls[0].text).toContain('INSERT INTO api_rate_limits');
    expect(sql.calls[0].text).toContain('ON CONFLICT (user_id, scope) DO UPDATE');
    expect(sql.calls[0].text).toContain('api_rate_limits.request_count <');
    expect(sql.calls[0].values).toEqual(['11111111-1111-4111-8111-111111111111', 'ai', 60_000, 60_000, 60_000, 10]);
  });

  it('rejects when the shared counter cannot be claimed', async () => {
    const sql = createMockSql([[{ allowed: false }]]);

    await expect(
      allowRequest(sql, '11111111-1111-4111-8111-111111111111', 'ai', { limit: 10, windowMs: 60_000 }),
    ).resolves.toBe(false);
  });

  it('fails closed on invalid policy values without querying the database', async () => {
    const sql = createMockSql();

    await expect(
      allowRequest(sql, '11111111-1111-4111-8111-111111111111', 'ai', { limit: 0, windowMs: 60_000 }),
    ).rejects.toThrow(/invalid rate-limit policy/i);
    expect(sql).not.toHaveBeenCalled();
  });
});
