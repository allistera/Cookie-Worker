// Unit tests for handleSearch, served by Meilisearch.
import { describe, expect, it, vi } from 'vitest';

import { handleSearch, mergeFederatedResults } from '../src/search.js';
import { MESSAGES_INDEX } from '../../../shared/meili.js';
import { DOCUMENTS_INDEX } from '../../../shared/meili/documents.js';
import { TASKS_INDEX } from '../../../shared/meili/tasks.js';
import { createMockSql } from './helpers.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
// No OPENAI_API_KEY needed: Meilisearch embeds server-side.
const ENV = /** @type {any} */ ({});

/** @param {string} [query] */
function url(query = '') {
  return new URL(`https://cookie-web-search.example/search${query}`);
}

/** @param {Partial<{hybridSearch: any, federatedSearch: any}>} [overrides] */
function deps(overrides = {}) {
  return {
    hybridSearch: vi.fn(async () => {
      throw new Error('hybridSearch should not be called in these tests');
    }),
    federatedSearch: vi.fn(async () => {
      throw new Error('federatedSearch should not be called in these tests');
    }),
    ...overrides,
  };
}

/** A hybridSearch stub, loosely typed so `.mock.calls[0][2]` reads back untyped. */
/** @param {(...args: any[]) => Promise<any>} impl @returns {any} */
function mockSearch(impl) {
  return vi.fn(impl);
}

/** A federatedSearch stub, loosely typed so `.mock.calls[0][1]` etc. read back untyped. */
/** @param {(...args: any[]) => Promise<any>} impl @returns {any} */
function mockFederatedSearch(impl) {
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

  it('includes archived mail but excludes deleted mail without an in: filter', async () => {
    const search = mockSearch(async () => []);
    const sql = createMockSql([[]]);

    await handleSearch(sql, USER_ID, url('?q=roof'), ENV, deps({ hybridSearch: search }));

    const query = search.mock.calls[0][2];
    expect(query.filter).not.toContain('is_archived');
    expect(query.filter).toContain('is_deleted = false');
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

describe('mergeFederatedResults', () => {
  const emailRow = { id: 'm1', subject: 'Roof' };
  const documentRow = {
    id: 'd1',
    title: 'Roof plan',
    tags: ['home'],
    starred: true,
    updated_at: 1,
  };

  it('re-merges hits from both indexes in federation hit order', () => {
    const hits = [
      { id: 'd1', _federation: { indexUid: 'documents' } },
      { id: 'm1', _federation: { indexUid: 'messages' } },
    ];

    const results = mergeFederatedResults(hits, [emailRow], [documentRow]);

    expect(results).toEqual([
      {
        type: 'document',
        id: 'd1',
        title: 'Roof plan',
        tags: ['home'],
        starred: true,
        updated_at: 1,
      },
      { type: 'email', ...emailRow },
    ]);
  });

  it('tags an email hit exactly with the existing email row shape, plus type', () => {
    const hits = [{ id: 'm1', _federation: { indexUid: 'messages' } }];
    const results = mergeFederatedResults(hits, [emailRow], []);
    expect(results).toEqual([{ type: 'email', id: 'm1', subject: 'Roof' }]);
  });

  it('narrows a document hit to id/title/tags/starred/updated_at', () => {
    const hits = [{ id: 'd1', _federation: { indexUid: 'documents' } }];
    const wideRow = { ...documentRow, folder_id: 'f1', created_at: 'x' };
    const results = mergeFederatedResults(hits, [], [wideRow]);
    expect(results).toEqual([
      {
        type: 'document',
        id: 'd1',
        title: 'Roof plan',
        tags: ['home'],
        starred: true,
        updated_at: 1,
      },
    ]);
  });

  it('narrows a task hit to id/content/description/projectId/dueDate/completedAt', () => {
    const hits = [{ id: 't1', _federation: { indexUid: 'task_items' } }];
    const wideRow = {
      id: 't1',
      content: 'Plan the trip',
      description: 'Flights and hotels',
      projectId: 'p1',
      dueDate: '2026-09-05',
      completedAt: null,
      created_at: 'x',
    };
    const results = mergeFederatedResults(hits, [], [], [wideRow]);
    expect(results).toEqual([
      {
        type: 'task',
        id: 't1',
        content: 'Plan the trip',
        description: 'Flights and hotels',
        projectId: 'p1',
        dueDate: '2026-09-05',
        completedAt: null,
      },
    ]);
  });

  // A hit whose row never hydrated (e.g. deleted between the Meilisearch
  // query and the Postgres read) is dropped rather than surfaced as null.
  it('drops a hit whose row did not hydrate', () => {
    const hits = [
      { id: 'm1', _federation: { indexUid: 'messages' } },
      { id: 'missing', _federation: { indexUid: 'messages' } },
    ];
    expect(mergeFederatedResults(hits, [emailRow], [])).toEqual([{ type: 'email', ...emailRow }]);
  });
});

describe('GET /search?scope=', () => {
  it('rejects an unrecognized scope', async () => {
    const sql = createMockSql([]);
    const response = await handleSearch(sql, USER_ID, url('?q=roof&scope=bogus'), ENV, deps());
    expect(response.status).toBe(400);
  });

  it('rejects a missing q the same way the unscoped endpoint does', async () => {
    const sql = createMockSql([]);
    const response = await handleSearch(sql, USER_ID, url('?scope=all'), ENV, deps());
    expect(response.status).toBe(400);
  });

  it('returns the fixed empty shape for a query of only empty operators', async () => {
    const sql = createMockSql([]);
    const response = await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('from:""')}&scope=all`),
      ENV,
      deps(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      query: 'from:""',
      results: [],
      estimatedTotalHits: 0,
      limit: 20,
      offset: 0,
    });
  });

  it('queries all three indexes for scope=all with no operators', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(sql, USER_ID, url('?q=roof&scope=all'), ENV, deps({ federatedSearch }));

    const [, units] = federatedSearch.mock.calls[0];
    expect(units.map((u) => u.descriptor.name).sort()).toEqual([
      'documents',
      'messages',
      'task_items',
    ]);
  });

  // Completed tasks stay indexed (so completing one is an update, not a
  // delete) but must never surface as results.
  it('filters the tasks leg to uncompleted tasks', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(sql, USER_ID, url('?q=roof&scope=all'), ENV, deps({ federatedSearch }));

    const [, units] = federatedSearch.mock.calls[0];
    const tasksUnit = units.find((u) => u.descriptor.name === TASKS_INDEX.name);
    expect(tasksUnit.filter).toContain('completed = false');
    // A filter Meilisearch can't serve (attribute not filterable) 503s in
    // production but passes any test that only checks the filter string.
    expect(TASKS_INDEX.filterable).toContain('completed');
  });

  it('drops the documents leg under scope=all when a mail-only operator is present', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('from:bob roof')}&scope=all`),
      ENV,
      deps({ federatedSearch }),
    );

    const [, units] = federatedSearch.mock.calls[0];
    expect(units.map((u) => u.descriptor.name)).toEqual(['messages']);
  });

  it('runs a single task_items query for scope=tasks', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(sql, USER_ID, url('?q=roof&scope=tasks'), ENV, deps({ federatedSearch }));

    const [, units] = federatedSearch.mock.calls[0];
    expect(units.map((u) => u.descriptor.name)).toEqual(['task_items']);
  });

  // Tasks have no sender, tags, star, folder or attachments — no operator
  // applies. Running the leg anyway would silently return every task as if
  // the operator weren't there.
  it.each(['from:alice', 'tag:Work', 'is:starred'])(
    'short-circuits with empty results for scope=tasks plus %s',
    async (operator) => {
      const federatedSearch = mockFederatedSearch(async () => ({
        hits: [],
        estimatedTotalHits: 0,
      }));
      const sql = createMockSql([]);

      const response = await handleSearch(
        sql,
        USER_ID,
        url(`?q=${encodeURIComponent(`${operator} roof`)}&scope=tasks`),
        ENV,
        deps({ federatedSearch }),
      );

      expect(response.status).toBe(200);
      expect((await response.json()).results).toEqual([]);
      expect(federatedSearch).not.toHaveBeenCalled();
    },
  );

  it('drops the tasks leg under scope=all when any operator is present', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('tag:Work roof')}&scope=all`),
      ENV,
      deps({ federatedSearch }),
    );

    const [, units] = federatedSearch.mock.calls[0];
    expect(units.map((u) => u.descriptor.name).sort()).toEqual(['documents', 'messages']);
  });

  it('keeps both legs under scope=all for tag:/is:starred — shared operators', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('tag:Work is:starred roof')}&scope=all`),
      ENV,
      deps({ federatedSearch }),
    );

    const [, units] = federatedSearch.mock.calls[0];
    expect(units.map((u) => u.descriptor.name).sort()).toEqual(['documents', 'messages']);
    const messagesUnit = units.find((u) => u.descriptor.name === MESSAGES_INDEX.name);
    const documentsUnit = units.find((u) => u.descriptor.name === DOCUMENTS_INDEX.name);
    expect(messagesUnit.filter).toContain("labels = 'Work'");
    expect(messagesUnit.filter).toContain('is_starred = true');
    expect(documentsUnit.filter).toContain("tags = 'Work'");
    expect(documentsUnit.filter).toContain('starred = true');
  });

  it('runs a single messages query for scope=mail', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(sql, USER_ID, url('?q=roof&scope=mail'), ENV, deps({ federatedSearch }));

    const [, units] = federatedSearch.mock.calls[0];
    expect(units.map((u) => u.descriptor.name)).toEqual(['messages']);
  });

  it('runs a single documents query for scope=documents', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(
      sql,
      USER_ID,
      url('?q=roof&scope=documents'),
      ENV,
      deps({ federatedSearch }),
    );

    const [, units] = federatedSearch.mock.calls[0];
    expect(units.map((u) => u.descriptor.name)).toEqual(['documents']);
  });

  // Documents have no sender/recipients/attachments/sent date/folder, so a
  // mail-only operator under scope=documents has nothing to filter on —
  // running it anyway would silently return every document as if the
  // operator weren't there, the exact failure mode scope=all's leg-dropping
  // avoids.
  it('short-circuits with empty results for scope=documents plus a mail-only operator', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    const response = await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('from:alice')}&scope=documents`),
      ENV,
      deps({ federatedSearch }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      query: 'from:alice',
      results: [],
      estimatedTotalHits: 0,
      limit: 20,
      offset: 0,
    });
    expect(federatedSearch).not.toHaveBeenCalled();
  });

  it('still runs scope=documents for tag:/is:starred, which are not mail-only', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    const response = await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('tag:Work is:starred roof')}&scope=documents`),
      ENV,
      deps({ federatedSearch }),
    );

    expect(response.status).toBe(200);
    expect(federatedSearch).toHaveBeenCalledTimes(1);
  });

  it('mode=keyword marks every unit non-semantic', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(
      sql,
      USER_ID,
      url('?q=roof&scope=all&mode=keyword'),
      ENV,
      deps({ federatedSearch }),
    );

    const [, units] = federatedSearch.mock.calls[0];
    expect(units.every((u) => u.semantic === false)).toBe(true);
  });

  // Filter-only queries (no free text) have no relevance signal, mirroring
  // the unscoped mail path's fallback to sort:['sent_at:desc'] — but only
  // when a single leg runs: sent_at (messages, seconds) and updated_at
  // (documents, milliseconds) are not cross-comparable.
  it('filter-only scope=mail falls back to sent_at:desc', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('tag:Work')}&scope=mail`),
      ENV,
      deps({ federatedSearch }),
    );

    const [, units] = federatedSearch.mock.calls[0];
    expect(units).toHaveLength(1);
    expect(units[0].sort).toEqual(['sent_at:desc']);
  });

  it('filter-only scope=documents falls back to updated_at:desc', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('tag:Work')}&scope=documents`),
      ENV,
      deps({ federatedSearch }),
    );

    const [, units] = federatedSearch.mock.calls[0];
    expect(units).toHaveLength(1);
    expect(units[0].sort).toEqual(['updated_at:desc']);
  });

  it('filter-only scope=all with both legs running gets no sort at all', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('tag:Work')}&scope=all`),
      ENV,
      deps({ federatedSearch }),
    );

    const [, units] = federatedSearch.mock.calls[0];
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.sort === undefined)).toBe(true);
  });

  // A filter-only, single-leg query still falls back to a mail-only operator
  // collapsing scope=all to one leg — sort applies there too.
  it('filter-only scope=all collapsed to mail-only by a mail-only operator still sorts', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('from:bob')}&scope=all`),
      ENV,
      deps({ federatedSearch }),
    );

    const [, units] = federatedSearch.mock.calls[0];
    expect(units).toHaveLength(1);
    expect(units[0].descriptor.name).toBe('messages');
    expect(units[0].sort).toEqual(['sent_at:desc']);
  });

  it('filter-only queries send no hybrid — semantic is false on every unit', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('tag:Work')}&scope=all`),
      ENV,
      deps({ federatedSearch }),
    );

    const [, units] = federatedSearch.mock.calls[0];
    expect(units.every((u) => u.semantic === false)).toBe(true);
  });

  it('hydrates and re-merges results from both indexes, and returns 200', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({
      hits: [
        { id: 'd1', _federation: { indexUid: 'documents' } },
        { id: 'm1', _federation: { indexUid: 'messages' } },
      ],
      estimatedTotalHits: 2,
    }));
    // fetchSearchEmails runs first (Promise.all order matches call order in
    // source), then fetchSearchDocuments.
    const sql = createMockSql([
      [{ id: 'm1', subject: 'Roof' }],
      [{ id: 'd1', title: 'Roof plan', tags: [], starred: false, updated_at: 1 }],
    ]);

    const response = await handleSearch(
      sql,
      USER_ID,
      url('?q=roof&scope=all'),
      ENV,
      deps({ federatedSearch }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      query: 'roof',
      results: [
        { type: 'document', id: 'd1', title: 'Roof plan', tags: [], starred: false, updated_at: 1 },
        { type: 'email', id: 'm1', subject: 'Roof' },
      ],
      estimatedTotalHits: 2,
      limit: 20,
      offset: 0,
    });
  });

  it('hydrates a task hit from Postgres and returns it as type "task"', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({
      hits: [{ id: 't1', _federation: { indexUid: 'task_items' } }],
      estimatedTotalHits: 1,
    }));
    // Only the tasks id list is non-empty, so fetchSearchTasks is the sole
    // Postgres call.
    const sql = createMockSql([
      [
        {
          id: 't1',
          content: 'Fix the roof',
          description: null,
          projectId: null,
          dueDate: null,
          completedAt: null,
        },
      ],
    ]);

    const response = await handleSearch(
      sql,
      USER_ID,
      url('?q=roof&scope=tasks'),
      ENV,
      deps({ federatedSearch }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results).toEqual([
      {
        type: 'task',
        id: 't1',
        content: 'Fix the roof',
        description: null,
        projectId: null,
        dueDate: null,
        completedAt: null,
      },
    ]);
    expect(sql.calls[0].text).toContain('FROM task_items t');
  });

  it('answers 503 when the federated Meilisearch call fails', async () => {
    const federatedSearch = mockFederatedSearch(async () => {
      throw new Error('meili down');
    });
    const sql = createMockSql([]);

    const response = await handleSearch(
      sql,
      USER_ID,
      url('?q=roof&scope=all'),
      ENV,
      deps({ federatedSearch }),
    );

    expect(response.status).toBe(503);
    expect(sql).not.toHaveBeenCalled();
  });

  it('clamps limit to the max and falls back to defaults for junk input', async () => {
    const federatedSearch = mockFederatedSearch(async () => ({ hits: [], estimatedTotalHits: 0 }));
    const sql = createMockSql([]);

    await handleSearch(
      sql,
      USER_ID,
      url('?q=roof&scope=all&limit=999&offset=-5'),
      ENV,
      deps({ federatedSearch }),
    );

    const [, , options] = federatedSearch.mock.calls[0];
    expect(options.limit).toBe(50);
    expect(options.offset).toBe(0);
  });

  it('leaves the unscoped /search response untouched', async () => {
    const search = vi.fn(async () => [{ id: 'm1' }]);
    const sql = createMockSql([[{ id: 'm1' }]]);

    const response = await handleSearch(
      sql,
      USER_ID,
      url('?q=roof'),
      ENV,
      deps({ hybridSearch: search }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ emails: [{ id: 'm1' }] });
  });
});
