import { describe, expect, it } from 'vitest';
import {
  fetchInterests,
  getInterests,
  MAX_INTEREST_LENGTH,
  MAX_INTERESTS,
  normalizeInterests,
  putInterests,
  saveInterests,
} from '../src/interests.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-9999-9999-999999999999';

describe('normalizeInterests', () => {
  it('trims, drops blanks and de-duplicates case-insensitively', () => {
    expect(normalizeInterests([' Vue ', 'vue', '', '   ', 'Postgres'])).toEqual([
      'Vue',
      'Postgres',
    ]);
  });

  it('caps the list length', () => {
    const many = Array.from({ length: MAX_INTERESTS + 5 }, (_, i) => `topic-${i}`);
    expect(normalizeInterests(many)).toHaveLength(MAX_INTERESTS);
  });

  it('caps each entry length', () => {
    const [only] = normalizeInterests(['x'.repeat(MAX_INTEREST_LENGTH + 40)]) ?? [];
    expect(only).toHaveLength(MAX_INTEREST_LENGTH);
  });

  it('accepts an empty list, which means "do not personalise"', () => {
    expect(normalizeInterests([])).toEqual([]);
  });

  it('returns null for anything that is not a list of strings', () => {
    expect(normalizeInterests(undefined)).toBeNull();
    expect(normalizeInterests('Vue')).toBeNull();
    expect(normalizeInterests(['Vue', 42])).toBeNull();
    expect(normalizeInterests([{ topic: 'Vue' }])).toBeNull();
  });
});

describe('fetchInterests', () => {
  it('reads the interests key out of prefs, defaulting to empty', () => {
    const sql = createMockSql();
    fetchInterests(sql, USER_ID);

    expect(sql.calls[0].text).toContain("prefs -> 'interests'");
    expect(sql.calls[0].text).toContain("'[]'::jsonb");
    expect(sql.calls[0].text).toContain('u.id =');
    expect(sql.calls[0].values).toEqual([USER_ID]);
  });
});

describe('saveInterests', () => {
  it('merges into prefs rather than replacing the whole object', () => {
    const sql = createMockSql([[{ interests: ['Vue'] }]]);
    saveInterests(sql, USER_ID, ['Vue']);

    expect(sql.calls[0].text).toContain('prefs = coalesce(prefs');
    expect(sql.calls[0].text).toContain('||');
    expect(sql.calls[0].values[0]).toEqual({ __json: { interests: ['Vue'] } });
    expect(sql.calls[0].values).toContain(USER_ID);
  });
});

describe('getInterests', () => {
  it('returns the stored interests', async () => {
    const sql = createMockSql([[{ interests: ['Vue', 'Postgres'] }]]);
    const response = await getInterests(sql, USER_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      interests: ['Vue', 'Postgres'],
      personaliseGithub: false,
    });
  });

  it('defaults to an empty list', async () => {
    const sql = createMockSql([[]]);
    const response = await getInterests(sql, USER_ID);
    expect(await response.json()).toEqual({ interests: [], personaliseGithub: false });
  });
});

describe('putInterests', () => {
  it('saves and returns the normalized list', async () => {
    const sql = createMockSql([[{ interests: ['Vue'] }]]);
    const response = await putInterests(sql, USER_ID, { interests: [' Vue ', 'vue'] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ interests: ['Vue'], personaliseGithub: false });
  });

  it('persists an explicit opt-in alongside topics and returns it', async () => {
    const sql = createMockSql([[{ interests: ['Rust'], personalise_github: true }]]);
    const response = await putInterests(sql, USER_ID, {
      interests: ['Rust'],
      personaliseGithub: true,
    });
    expect(await response.json()).toEqual({ interests: ['Rust'], personaliseGithub: true });
    expect(sql.json).toHaveBeenCalledWith({ interests: ['Rust'], personaliseGithub: true });
  });

  it('rejects invalid personalisation flags', async () => {
    const sql = createMockSql();
    const response = await putInterests(sql, USER_ID, { interests: [], personaliseGithub: 'true' });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload without touching the database', async () => {
    const sql = createMockSql();
    const response = await putInterests(sql, USER_ID, { interests: 'Vue' });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('404s when the user does not exist', async () => {
    const sql = createMockSql([[]]);
    const response = await putInterests(sql, USER_ID, { interests: ['Vue'] });
    expect(response.status).toBe(404);
  });
});
