import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth/quota wiring is what this file tests — including the
// quota-ordering guarantee Cookie-Web pinned in ai-quota-validation.test.js:
// invalid /ask input must never spend AI quota. GET /search never claims AI
// quota at all: Meilisearch embeds/ranks server-side.
const mockQuery = vi.fn(
  /** @param {any[]} _args */ (..._args) => Promise.resolve(/** @type {any[]} */ ([])),
);
const sqlEnd = vi.fn(async () => undefined);
vi.mock('postgres', () => ({
  default: () => {
    /** @type {any} */
    const sql = (/** @type {any[]} */ ...args) => mockQuery(...args);
    sql.begin = async (/** @type {(sql: any) => unknown} */ callback) => callback(sql);
    sql.end = sqlEnd;
    return sql;
  },
}));

const verifyAccessToken = vi.fn();
vi.mock('../../../shared/auth-jwt.js', () => ({
  verifyAccessToken: (...args) => verifyAccessToken(...args),
  authFailureResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

const allowRequest = vi.fn();
vi.mock('../../../shared/rate-limit.js', () => ({
  allowRequest: (...args) => allowRequest(...args),
}));

// GET /search and POST /ask default to the Meilisearch engine now; only
// hybridSearch is faked here (MESSAGES_INDEX/meiliMessageFilter stay real —
// they're pure and have their own unit tests), so routing/CORS/auth/quota
// wiring can be tested without a real Meilisearch Cloud instance.
const hybridSearch = vi.fn();
vi.mock('../../../shared/meili.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, hybridSearch: (...args) => hybridSearch(...args) };
});

const captureHandledException = vi.fn();
vi.mock('../src/sentry.js', () => ({
  createSentryOptions: () => ({ enabled: false }),
  captureHandledException: (...args) => captureHandledException(...args),
}));

const worker = (await import('../src/worker.js')).default;

const PRODUCTION = 'https://mail.infinitywave.online';
const env = /** @type {any} */ ({
  HYPERDRIVE: { connectionString: 'postgres://stub' },
  AUTH0_DOMAIN: 'tenant.example.auth0.com',
  AUTH0_AUDIENCE: 'https://cookie-web/api',
  ALLOWED_ORIGIN: PRODUCTION,
  OPENAI_API_KEY: 'test-key',
});
const ctx = /** @type {any} */ ({ waitUntil: (promise) => promise });

/** @param {string} path @param {RequestInit} [init] */
function request(path, init = {}) {
  return new Request(`https://cookie-web-search.example${path}`, {
    ...init,
    headers: { Origin: PRODUCTION, Authorization: 'Bearer token', ...init.headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyAccessToken.mockResolvedValue({ userId: 'user-1' });
  allowRequest.mockResolvedValue(true);
  mockQuery.mockReset().mockResolvedValue([]);
  hybridSearch.mockReset().mockResolvedValue([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0.1] }] }),
    })),
  );
});

describe('CORS preflight', () => {
  test('answers OPTIONS from an allowed origin without touching auth or the database', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-search.example/search', {
        method: 'OPTIONS',
        headers: { Origin: PRODUCTION },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(204);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });
});

describe('GET /search', () => {
  test('rejects a missing q without touching quota or the database', async () => {
    const response = await worker.fetch(request('/search'), env, ctx);
    expect(response.status).toBe(400);
    expect(allowRequest).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a query of only empty operators returns [] without spending quota', async () => {
    const response = await worker.fetch(request('/search?q=from:%22%22'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ emails: [] });
    expect(allowRequest).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // Meilisearch is the default engine and embeds/ranks server-side, so a
  // plain GET /search never touches this worker's AI quota or Postgres
  // retrieval legs — only the hydration query for the ids it returns.
  test('searches Meilisearch by default without claiming AI quota', async () => {
    hybridSearch.mockResolvedValue([{ id: 'm1' }]);
    const response = await worker.fetch(request('/search?q=invoice'), env, ctx);
    expect(response.status).toBe(200);
    expect(hybridSearch).toHaveBeenCalledTimes(1);
    expect(allowRequest).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalled(); // hydration by id
  });

  test('answers 503 when Meilisearch fails', async () => {
    hybridSearch.mockRejectedValue(new Error('meili down'));
    const response = await worker.fetch(request('/search?q=invoice'), env, ctx);
    expect(response.status).toBe(503);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a POST to /search returns 405', async () => {
    const response = await worker.fetch(request('/search?q=x', { method: 'POST' }), env, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });
});

describe('POST /ask', () => {
  test('rejects malformed JSON without touching quota', async () => {
    const response = await worker.fetch(request('/ask', { method: 'POST', body: '{' }), env, ctx);
    expect(response.status).toBe(400);
    expect(allowRequest).not.toHaveBeenCalled();
  });

  test('rejects a blank question without touching quota or the database', async () => {
    const response = await worker.fetch(
      request('/ask', { method: 'POST', body: JSON.stringify({ question: '   ' }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(allowRequest).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('answers 503 with its own wording when no OpenAI key is set', async () => {
    const response = await worker.fetch(
      request('/ask', { method: 'POST', body: JSON.stringify({ question: 'hi' }) }),
      { ...env, OPENAI_API_KEY: undefined },
      ctx,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Assistant is not configured' });
  });

  test('answers 429 with its own wording when the quota is exhausted', async () => {
    allowRequest.mockResolvedValue(false);
    const response = await worker.fetch(
      request('/ask', { method: 'POST', body: JSON.stringify({ question: 'hi' }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'Too many questions, slow down' });
  });

  test('returns the no-results answer when retrieval finds nothing', async () => {
    const response = await worker.fetch(
      request('/ask', { method: 'POST', body: JSON.stringify({ question: 'anything new?' }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      answer: "I couldn't find any emails related to that. Try rephrasing your question.",
      sources: [],
    });
    expect(hybridSearch).toHaveBeenCalledTimes(1);
  });

  test('retrieves via Meilisearch and answers from the hydrated rows', async () => {
    hybridSearch.mockResolvedValue([{ id: 'm1' }]);
    mockQuery.mockResolvedValueOnce([
      { id: 'm1', from_name: 'Bob', from_address: 'bob@example.com', subject: 'Roof', sent_at: 1 },
    ]);
    const response = await worker.fetch(
      request('/ask', {
        method: 'POST',
        body: JSON.stringify({ question: 'what about the roof?' }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sources).toEqual([{ id: 'm1', subject: 'Roof', from_name: 'Bob' }]);
  });

  // Meilisearch is required for retrieval: a failure is an error, not a
  // silently smaller (or empty) set of sources.
  test('answers 503 when Meilisearch retrieval fails', async () => {
    hybridSearch.mockRejectedValue(new Error('meili down'));
    const response = await worker.fetch(
      request('/ask', { method: 'POST', body: JSON.stringify({ question: 'anything new?' }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(503);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a GET to /ask returns 405', async () => {
    const response = await worker.fetch(request('/ask'), env, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});

describe('routing and cleanup', () => {
  test('an unknown path returns 404', async () => {
    const response = await worker.fetch(request('/unknown'), env, ctx);
    expect(response.status).toBe(404);
  });

  test('closes the sql connection on a successful request', async () => {
    await worker.fetch(request('/search?q=tag:Personal'), env, ctx);
    expect(sqlEnd).toHaveBeenCalledOnce();
  });
});
