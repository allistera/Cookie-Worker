import { describe, expect, it } from 'vitest';
import { fetchDailyNoteSeed, getDailyNoteSeed, putDailyNoteSeed, saveDailyNoteSeed } from '../src/dailyNoteSeed.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-9999-9999-999999999999';
const BLOCKS = [{ type: 'header', data: { text: 'Standup', level: 2 } }];

describe('fetchDailyNoteSeed', () => {
  it('reads the dailyNoteSeed key out of prefs, defaulting to empty', () => {
    const sql = createMockSql();
    fetchDailyNoteSeed(sql, USER_ID);

    expect(sql.calls[0].text).toContain("prefs -> 'dailyNoteSeed'");
    expect(sql.calls[0].text).toContain("'[]'::jsonb");
    expect(sql.calls[0].text).toContain('u.id =');
    expect(sql.calls[0].values).toEqual([USER_ID]);
  });
});

describe('saveDailyNoteSeed', () => {
  it('merges into prefs rather than replacing the whole object', () => {
    const sql = createMockSql([[{ blocks: BLOCKS }]]);
    saveDailyNoteSeed(sql, USER_ID, BLOCKS);

    expect(sql.calls[0].text).toContain('prefs = coalesce(prefs');
    expect(sql.calls[0].text).toContain('||');
    expect(sql.calls[0].values[0]).toEqual({ __json: { dailyNoteSeed: BLOCKS } });
    expect(sql.calls[0].values).toContain(USER_ID);
  });

  it('accepts an empty array, which means "use the built-in default"', () => {
    const sql = createMockSql([[{ blocks: [] }]]);
    saveDailyNoteSeed(sql, USER_ID, []);

    expect(sql.calls[0].values[0]).toEqual({ __json: { dailyNoteSeed: [] } });
  });
});

describe('getDailyNoteSeed', () => {
  it('returns the stored blocks', async () => {
    const sql = createMockSql([[{ blocks: BLOCKS }]]);
    const response = await getDailyNoteSeed(sql, USER_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ blocks: BLOCKS });
  });

  it('defaults to an empty array', async () => {
    const sql = createMockSql([[]]);
    const response = await getDailyNoteSeed(sql, USER_ID);
    expect(await response.json()).toEqual({ blocks: [] });
  });
});

describe('putDailyNoteSeed', () => {
  it('saves and returns the new blocks', async () => {
    const sql = createMockSql([[{ blocks: BLOCKS }]]);
    const response = await putDailyNoteSeed(sql, USER_ID, { blocks: BLOCKS });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ blocks: BLOCKS });
  });

  it('rejects non-array blocks without touching the database', async () => {
    const sql = createMockSql();
    const response = await putDailyNoteSeed(sql, USER_ID, { blocks: 'nope' });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('404s when the user does not exist', async () => {
    const sql = createMockSql([[]]);
    const response = await putDailyNoteSeed(sql, USER_ID, { blocks: [] });
    expect(response.status).toBe(404);
  });
});
