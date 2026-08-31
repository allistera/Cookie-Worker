// Unit tests for handleSearch, served by Meilisearch.
import { describe, expect, it, vi } from 'vitest';

import { handleSearch } from '../src/search.js';
import { MESSAGES_INDEX } from '../../../shared/meili.js';
import { createMockSql } from './helpers.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
// No OPENAI_API_KEY needed: Meilisearch embeds server-side.
const ENV = /** @type {any} */ ({});

/** @param {string} [query] */
function url(query = '') {
  return new URL(`https://cookie-web-search.example/search${query}`);
}

/** @param {Partial<{hybridSearch: any}>} [overrides] */
function deps(overrides = {}) {
  return {
    hybridSearch: vi.fn(async () => {
      throw new Error('hybridSearch should not be called in these tests');
    }),
    ...overrides,
  };
}

/** A hybridSearch stub, loosely typed so `.mock.calls[0][2]` reads back untyped. */
/** @param {(...args: any[]) => Promise<any>} impl @returns {any} */
function mockSearch(impl) {
  return vi.fn(impl);
}

describe('message search engine', () => {
  it('searches Meilisearch', async () => {
    const search = mockSearch(async () => [{ id: 'm1' }]);
    const sql = createMockSql([[{ id: 'm1' }]]);

    const response = await handleSearch(
      sql,
      USER_ID,
      url('?q=roof'),
      ENV,
      deps({ hybridSearch: search }),
    );

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledTimes(1);
  });

  // Was substring in Postgres; exact in Meilisearch, per the spec —
  // queryParse.js's key is `from`, not `sender`.
  it('matches from: exactly', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('from:bob@example.com roof')}`),
      ENV,
      deps({ hybridSearch: search }),
    );

    const query = search.mock.calls[0][2];
    expect(query.filter).toContain("from_address = 'bob@example.com'");
    // A filter Meilisearch can't actually serve (the attribute isn't
    // filterable) 503s in production but passes any test that only checks
    // the filter string — this is the mismatch that shipped from_address =
    // as a filter with from_address missing from MESSAGES_INDEX.filterable.
    expect(MESSAGES_INDEX.filterable).toContain('from_address');
  });

  // Was substring in Postgres; exact in Meilisearch, per the spec.
  it('matches to: exactly', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('to:jane@example.com roof')}`),
      ENV,
      deps({ hybridSearch: search }),
    );

    const query = search.mock.calls[0][2];
    expect(query.filter).toContain("to_address = 'jane@example.com'");
    expect(MESSAGES_INDEX.filterable).toContain('to_address');
  });

  // Every in: value queryParse.js's FOLDERS recognizes {inbox, sent, spam,
  // snoozed, done, all}, end to end through parseSearchQuery ->
  // meiliMessageFilter — the unit-level mapping is asserted exhaustively in
  // shared/test/meili.test.js; these confirm handleSearch actually wires the
  // parsed `in:` value through.
  it.each([
    ['in:done', 'is_archived = true'],
    ['in:sent', 'is_sent = true'],
    ['in:spam', 'is_spam = true'],
    ['in:snoozed', 'scheduled_for >'],
    ['in:inbox', 'scheduled_for <='],
    ['in:all', 'is_deleted = false'],
  ])('turns %s into a filter containing "%s"', async (operator, expected) => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent(`${operator} roof`)}`),
      ENV,
      deps({ hybridSearch: search }),
    );

    const query = search.mock.calls[0][2];
    expect(query.filter).toContain(expected);
  });

  // Regression: an earlier version of meiliMessageFilter omitted "AND NOT
  // is_archived" for in:sent, so an archived sent copy would have matched.
  it('in:sent also excludes archived mail', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('in:sent roof')}`),
      ENV,
      deps({ hybridSearch: search }),
    );

    const query = search.mock.calls[0][2];
    expect(query.filter).toContain('is_archived = false');
  });

  // No in: filter at all excludes Done mail too — not just trashed mail.
  it('excludes archived (Done) mail when there is no in: filter', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(sql, USER_ID, url('?q=roof'), ENV, deps({ hybridSearch: search }));

    const query = search.mock.calls[0][2];
    expect(query.filter).toContain('is_archived = false');
  });

  it('in:all does not exclude archived mail (only trashed mail)', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('in:all roof')}`),
      ENV,
      deps({ hybridSearch: search }),
    );

    const query = search.mock.calls[0][2];
    expect(query.filter).not.toContain('is_archived');
  });

  it('turns has:attachment into hasAttachment, not "attachment"', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('has:attachment roof')}`),
      ENV,
      deps({ hybridSearch: search }),
    );

    const query = search.mock.calls[0][2];
    expect(query.filter).toContain('has_attachments = true');
  });

  // sent_at is stored in the Meilisearch index as epoch SECONDS, not
  // milliseconds.
  it('filters before:/after: on sent_at in epoch seconds', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('after:2026-01-01 before:2026-01-31 roof')}`),
      ENV,
      deps({ hybridSearch: search }),
    );

    const { filter } = search.mock.calls[0][2];
    const afterSeconds = Math.floor(Date.parse('2026-01-01') / 1000);
    const beforeSeconds = Math.floor(Date.parse('2026-01-31') / 1000);
    expect(filter).toContain(`sent_at >= ${afterSeconds}`);
    expect(filter).toContain(`sent_at < ${beforeSeconds}`);
    // Not milliseconds — a stray zero would silently break every date filter.
    expect(filter).not.toContain(`${afterSeconds}000`);
  });

  it('excludes deleted messages unless asked for them', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(sql, USER_ID, url('?q=roof'), ENV, deps({ hybridSearch: search }));

    const query = search.mock.calls[0][2];
    expect(query.filter).toContain('is_deleted = false');
  });

  // A filters-only query has no relevance signal, so it sorts newest-first —
  // what the recency leg did.
  it('sorts by sent_at when there is no free text', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(sql, USER_ID, url('?q=tag%3APersonal'), ENV, deps({ hybridSearch: search }));

    const query = search.mock.calls[0][2];
    expect(query.sort).toEqual(['sent_at:desc']);
  });

  it('does not sort when there is free text — relevance drives ranking', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(sql, USER_ID, url('?q=roof'), ENV, deps({ hybridSearch: search }));

    const query = search.mock.calls[0][2];
    expect(query.sort).toBeUndefined();
  });

  // mode=keyword is Cookie-Web's per-keystroke type-ahead path. It must not
  // spend an embedding call on every keystroke, so it forces Meilisearch's
  // keyword-only setting (semanticRatio 0) rather than falling through to
  // the descriptor's default hybrid ratio.
  it('mode=keyword sends semanticRatio: 0', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(
      sql,
      USER_ID,
      url('?q=roof&mode=keyword'),
      ENV,
      deps({ hybridSearch: search }),
    );

    const query = search.mock.calls[0][2];
    expect(query.semanticRatio).toBe(0);
  });

  // No mode param (or any value other than "keyword") is the default hybrid
  // path — semanticRatio is left unset here so hybridSearch falls back to
  // MESSAGES_INDEX's own default (0.5).
  it('defaults to the descriptor semanticRatio when mode is not keyword', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(sql, USER_ID, url('?q=roof'), ENV, deps({ hybridSearch: search }));

    const query = search.mock.calls[0][2];
    expect(query.semanticRatio).toBeUndefined();
    expect(MESSAGES_INDEX.semanticRatio).toBe(0.5);
  });

  // Meilisearch is required: a failure is an error, not a silent fallback.
  it('returns 503 when Meilisearch fails', async () => {
    const search = mockSearch(async () => {
      throw new Error('meili down');
    });
    const sql = createMockSql([]);

    const response = await handleSearch(
      sql,
      USER_ID,
      url('?q=roof'),
      ENV,
      deps({ hybridSearch: search }),
    );

    expect(response.status).toBe(503);
    expect(sql).not.toHaveBeenCalled();
  });

  // Meilisearch hits carry only ids; the response is hydrated from Postgres.
  it('hydrates Meilisearch hits from Postgres by id', async () => {
    const search = mockSearch(async () => [{ id: 'm1' }, { id: 'm2' }]);
    const sql = createMockSql([[{ id: 'm1' }, { id: 'm2' }]]);

    const response = await handleSearch(
      sql,
      USER_ID,
      url('?q=roof'),
      ENV,
      deps({ hybridSearch: search }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.emails).toHaveLength(2);
    expect(sql.calls[0].text).toContain('m.id = ANY(');
  });
});
