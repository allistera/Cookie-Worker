import { describe, expect, test, vi } from 'vitest';
import { getAutoArchive, putAutoArchive } from '../src/autoArchive.js';

const flags = { marketing: true, coldPitches: false, socialNoise: true };
/** @param {any[]} rows @returns {any} */
function mockSql(rows = []) {
  const sql = Object.assign(
    vi.fn(async () => rows),
    {
      begin: async (callback) => callback(sql),
      json: (value) => value,
    },
  );
  return sql;
}

describe('auto archive settings API', () => {
  test('returns disabled defaults without creating preferences', async () => {
    const sql = mockSql();
    const response = await getAutoArchive(sql, 'user-1');
    expect(await response.json()).toEqual({
      autoArchive: { marketing: false, coldPitches: false, socialNoise: false },
    });
    expect(sql).toHaveBeenCalledTimes(1);
  });

  test.each([
    null,
    {},
    { autoArchive: {} },
    { autoArchive: { ...flags, marketing: 'true' } },
    { autoArchive: { ...flags, unknown: true } },
  ])('rejects invalid input %j without writes', async (body) => {
    const sql = mockSql();
    expect((await putAutoArchive(sql, 'user-1', body)).status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('saves only the authenticated user’s settings and merges unrelated preferences', async () => {
    const sql = mockSql([{ settings: null, activated_at: new Date('2026-09-07T10:00:00Z') }]);
    const response = await putAutoArchive(sql, 'user-1', { autoArchive: flags });
    expect(await response.json()).toEqual({ autoArchive: flags });
    const calls = /** @type {any} */ (sql).mock.calls;
    expect(calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(calls[1][0].join('?')).toContain("coalesce(prefs, '{}'::jsonb) ||");
    expect(calls[1]).toContain('user-1');
  });

  test('returns 404 for a missing user', async () => {
    expect((await putAutoArchive(mockSql(), 'user-1', { autoArchive: flags })).status).toBe(404);
  });
});
