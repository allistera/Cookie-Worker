// What a search tells Honeycomb, Server-Timing and Sentry: the shape and the
// outcome of the request, never its text. The handlers' behaviour itself is
// covered in search.test.js; this file only reads what they record.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTracingRecorder } from '../../../test/fixtures/tracing-recorder.js';
import { createMockSql } from './helpers.js';

const recorder = vi.hoisted(() => ({ current: /** @type {any} */ (null) }));
vi.mock('cloudflare:workers', () => ({
  tracing: {
    getActiveSpan: () => recorder.current?.tracing.getActiveSpan(),
    /** @param {string} name */
    startSpan: (name) => recorder.current?.tracing.startSpan(name),
  },
}));

const captureHandledException = vi.hoisted(() => vi.fn());
vi.mock('../src/sentry.js', () => ({ captureHandledException }));

// /ask claims AI quota before retrieving; the quota itself is not under test.
vi.mock('../../../shared/rate-limit.js', () => ({ allowRequest: async () => true }));

const { handleSearch } = await import('../src/search.js');
const { handleAsk } = await import('../src/ask.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ENV = /** @type {any} */ ({ OPENAI_API_KEY: 'test-key' });

/** @param {string} [query] */
function url(query = '') {
  return new URL(`https://cookie-web-search.example/search${query}`);
}

/** @param {Partial<{hybridSearch: any, federatedSearch: any}>} [overrides] */
function deps(overrides = {}) {
  return {
    hybridSearch: vi.fn(async () => {
      throw new Error('hybridSearch should not be called in this test');
    }),
    federatedSearch: vi.fn(async () => {
      throw new Error('federatedSearch should not be called in this test');
    }),
    ...overrides,
  };
}

/** A gateway answer from the tunnel in front of Meilisearch, as the SDK raises it. */
function gatewayError() {
  return Object.assign(new Error('Request failed with status 530'), { response: { status: 530 } });
}

/** @param {{id: string}[]} hits @param {string} indexUid */
function federated(hits, indexUid) {
  return hits.map((hit) => ({ ...hit, _federation: { indexUid } }));
}

function attributes() {
  return recorder.current.root.attributes;
}

beforeEach(() => {
  recorder.current = createTracingRecorder();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('what a mail search records', () => {
  it('describes the request by shape and outcome, without its text', async () => {
    const sql = createMockSql([[{ id: 'm1' }]]);
    const response = await handleSearch(
      sql,
      USER_ID,
      url('?q=roof%20quote'),
      ENV,
      deps({ hybridSearch: vi.fn(async () => [{ id: 'm1' }, { id: 'm2' }]) }),
    );

    expect(response.status).toBe(200);
    expect(attributes()).toEqual({
      'cookie.search.scope': 'mail',
      'cookie.search.federated': false,
      'cookie.search.mode': 'hybrid',
      'cookie.search.has_text': true,
      'cookie.search.filters': 0,
      'cookie.search.legs': 'messages',
      'cookie.search.hits': 2,
      // One hit no longer hydrates from Postgres: that gap is the stale-index signal.
      'cookie.search.hydrated': 1,
      'cookie.search.outcome': 'ok',
    });
    expect(JSON.stringify(attributes())).not.toContain('roof');
    expect(response.headers.get('Server-Timing')).toMatch(/^meili;dur=[\d.]+, hydrate;dur=[\d.]+$/);
  });

  it('records keyword mode and the operator count for a type-ahead query', async () => {
    const sql = createMockSql([[]]);
    await handleSearch(
      sql,
      USER_ID,
      url(`?q=${encodeURIComponent('from:bob@example.com roof')}&mode=keyword`),
      ENV,
      deps({ hybridSearch: vi.fn(async () => []) }),
    );

    expect(attributes()).toMatchObject({
      'cookie.search.mode': 'keyword',
      'cookie.search.filters': 1,
      'cookie.search.hits': 0,
      'cookie.search.hydrated': 0,
      'cookie.search.outcome': 'ok',
    });
    expect(JSON.stringify(attributes())).not.toContain('bob');
  });

  it('names requests that did no retrieval', async () => {
    await handleSearch(
      createMockSql(),
      USER_ID,
      url(`?q=${encodeURIComponent('from:""')}`),
      ENV,
      deps(),
    );
    expect(attributes()['cookie.search.outcome']).toBe('empty_query');

    recorder.current = createTracingRecorder();
    await handleSearch(createMockSql(), USER_ID, url(''), ENV, deps());
    expect(attributes()['cookie.search.outcome']).toBe('invalid');

    recorder.current = createTracingRecorder();
    await handleSearch(createMockSql(), USER_ID, url('?q=tag:x+roof&scope=tasks'), ENV, deps());
    expect(attributes()['cookie.search.outcome']).toBe('skipped');
  });
});

describe('a Meilisearch failure', () => {
  it('reports a gateway blip as transient, with the retrieval stage timed', async () => {
    const sql = createMockSql();
    const response = await handleSearch(
      sql,
      USER_ID,
      url('?q=roof'),
      ENV,
      deps({ hybridSearch: vi.fn(async () => Promise.reject(gatewayError())) }),
    );

    expect(response.status).toBe(503);
    expect(attributes()['cookie.search.outcome']).toBe('meili_transient');
    expect(captureHandledException).toHaveBeenCalledExactlyOnceWith(
      'meili_search_transient',
      expect.any(Error),
      ENV,
      { scope: 'mail', mode: 'hybrid' },
    );
    expect(response.headers.get('Server-Timing')).toMatch(/^meili;dur=[\d.]+$/);
  });

  it('reports a rejection by Meilisearch itself under its own operation', async () => {
    const response = await handleSearch(
      createMockSql(),
      USER_ID,
      url('?q=roof&scope=all'),
      ENV,
      deps({
        federatedSearch: vi.fn(async () => Promise.reject(new Error('Invalid filter'))),
      }),
    );

    expect(response.status).toBe(503);
    expect(attributes()['cookie.search.outcome']).toBe('meili_rejected');
    expect(captureHandledException).toHaveBeenCalledExactlyOnceWith(
      'meili_search_rejected',
      expect.any(Error),
      ENV,
      { scope: 'all', mode: 'hybrid' },
    );
  });
});

describe('what a federated search records', () => {
  it('lists the legs that ran and the totals Meilisearch reported', async () => {
    const sql = createMockSql([[{ id: 'm1' }], [{ id: 'd1', title: 'Roof' }], []]);
    const federatedSearch = vi.fn(async () => ({
      hits: [
        ...federated([{ id: 'm1' }], 'messages'),
        ...federated([{ id: 'd1' }], 'documents'),
        ...federated([{ id: 't1' }], 'task_items'),
      ],
      estimatedTotalHits: 41,
    }));

    const response = await handleSearch(
      sql,
      USER_ID,
      url('?q=roof&scope=all'),
      ENV,
      deps({ federatedSearch }),
    );

    expect(response.status).toBe(200);
    expect(attributes()).toMatchObject({
      'cookie.search.scope': 'all',
      'cookie.search.federated': true,
      'cookie.search.verified': false,
      'cookie.search.legs': 'messages,documents,task_items',
      'cookie.search.hits': 3,
      'cookie.search.estimated_total': 41,
      'cookie.search.hydrated': 2,
      'cookie.search.outcome': 'ok',
    });
    expect(response.headers.get('Server-Timing')).toMatch(/^meili;dur=[\d.]+, hydrate;dur=[\d.]+$/);
  });

  it('counts verified pagination batches and reports each stage once', async () => {
    // First batch: fifty hits, none of which hydrate; second: one live row.
    const stale = Array.from({ length: 50 }, (_, index) => ({ id: `s${index}` }));
    const federatedSearch = vi
      .fn()
      .mockResolvedValueOnce({ hits: federated(stale, 'messages'), estimatedTotalHits: 51 })
      .mockResolvedValueOnce({
        hits: federated([{ id: 'm1' }], 'messages'),
        estimatedTotalHits: 51,
      });
    const sql = createMockSql([[], [{ id: 'm1' }]]);

    const response = await handleSearch(
      sql,
      USER_ID,
      url('?q=roof&scope=mail&mode=keyword&pagination=verified&limit=1'),
      ENV,
      deps({ federatedSearch }),
    );

    expect(response.status).toBe(200);
    expect(attributes()).toMatchObject({
      'cookie.search.verified': true,
      'cookie.search.verified_batches': 2,
      'cookie.search.hits': 51,
      'cookie.search.hydrated': 1,
      'cookie.search.estimated_total': 51,
      'cookie.search.outcome': 'ok',
    });
    const timing = response.headers.get('Server-Timing') ?? '';
    expect(timing.match(/meili;/g)).toHaveLength(1);
    expect(timing.match(/hydrate;/g)).toHaveLength(1);
  });
});

describe('what the assistant records about retrieval', () => {
  it('uses the search vocabulary for its retrieval leg', async () => {
    const response = await handleAsk(createMockSql(), USER_ID, { question: 'anything new?' }, ENV, {
      hybridSearch: vi.fn(async () => []),
    });

    expect(response.status).toBe(200);
    expect(attributes()).toEqual({
      'cookie.search.scope': 'ask',
      'cookie.search.federated': false,
      'cookie.search.mode': 'hybrid',
      'cookie.search.legs': 'messages',
      'cookie.search.hits': 0,
      'cookie.search.outcome': 'ok',
    });
  });

  it('reports a retrieval failure to Sentry like a search failure', async () => {
    const response = await handleAsk(createMockSql(), USER_ID, { question: 'anything new?' }, ENV, {
      hybridSearch: vi.fn(async () => Promise.reject(gatewayError())),
    });

    expect(response.status).toBe(503);
    expect(attributes()['cookie.search.outcome']).toBe('meili_transient');
    expect(captureHandledException).toHaveBeenCalledExactlyOnceWith(
      'meili_search_transient',
      expect.any(Error),
      ENV,
      { scope: 'ask', mode: 'hybrid' },
    );
  });
});
