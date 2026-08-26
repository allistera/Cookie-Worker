import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth/quota wiring is what this file tests — including the
// quota-ordering guarantees Cookie-Web pinned in ai-quota-validation.test.js:
// invalid input must never spend AI quota, and keyword-only search must not
// either.
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

  test('keyword mode searches without claiming AI quota', async () => {
    const response = await worker.fetch(request('/search?q=invoice&mode=keyword'), env, ctx);
    expect(response.status).toBe(200);
    expect(allowRequest).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalled();
  });

  test('a filters-only query uses the recency leg without claiming quota', async () => {
    const response = await worker.fetch(request('/search?q=tag:Personal'), env, ctx);
    expect(response.status).toBe(200);
    expect(allowRequest).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalled();
  });

  test('hybrid free-text search claims the shared ai scope', async () => {
    await worker.fetch(request('/search?q=invoice'), env, ctx);
    expect(allowRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'ai', {
      limit: 10,
      windowMs: 60_000,
    });
  });

  test('answers 429 when the quota is exhausted', async () => {
    allowRequest.mockResolvedValue(false);
    const response = await worker.fetch(request('/search?q=invoice'), env, ctx);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'Too many searches, slow down' });
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
