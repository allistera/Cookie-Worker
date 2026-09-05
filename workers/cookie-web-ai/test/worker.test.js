import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth/quota wiring is what this file tests — the business logic
// (compose.js/summarize.js) has its own unit tests, so OpenAI and the
// database are stubbed here.
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
  return new Request(`https://cookie-web-ai.example${path}`, {
    method: 'POST',
    ...init,
    headers: { Origin: PRODUCTION, Authorization: 'Bearer token', ...init.headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyAccessToken.mockResolvedValue({ userId: 'user-1' });
  allowRequest.mockResolvedValue(true);
  mockQuery.mockReset().mockResolvedValue([]);
});

describe('CORS preflight', () => {
  test('answers OPTIONS from an allowed origin without touching auth or the database', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-ai.example/compose', {
        method: 'OPTIONS',
        headers: { Origin: PRODUCTION },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });
});

describe('auth and configuration', () => {
  test('rejects a request that fails verification, without claiming quota', async () => {
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const response = await worker.fetch(request('/compose', { body: '{}' }), env, ctx);
    expect(response.status).toBe(401);
    expect(allowRequest).not.toHaveBeenCalled();
  });

  test.each([
    ['/compose', 'AI compose is not configured'],
    ['/summarize', 'AI summarization is not configured'],
    ['/document', 'AI documents are not configured'],
  ])('%s answers 503 with its own wording when no OpenAI key is set', async (path, error) => {
    const response = await worker.fetch(
      request(path, { body: '{}' }),
      { ...env, OPENAI_API_KEY: undefined },
      ctx,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error });
  });
});

describe('rate limiting', () => {
  test('claims the shared ai scope before dispatching', async () => {
    await worker.fetch(
      request('/compose', { body: JSON.stringify({ instruction: 'x' }) }),
      env,
      ctx,
    );
    expect(allowRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'ai', {
      limit: 10,
      windowMs: 60_000,
    });
  });

  test.each([
    ['/compose', 'Too many compose requests, slow down'],
    ['/summarize', 'Too many summary requests, slow down'],
    ['/document', 'Too many document requests, slow down'],
  ])('%s answers 429 with its own wording when the quota is exhausted', async (path, error) => {
    allowRequest.mockResolvedValue(false);
    const response = await worker.fetch(request(path, { body: '{}' }), env, ctx);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error });
  });

  test('answers 503 when quota enforcement itself fails', async () => {
    allowRequest.mockRejectedValue(new Error('connection reset'));
    const response = await worker.fetch(request('/summarize', { body: '{}' }), env, ctx);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'AI summarization is temporarily unavailable' });
  });
});

describe('routing', () => {
  test('POST /compose dispatches to the compose handler (reaches its validation)', async () => {
    const response = await worker.fetch(request('/compose', { body: '{}' }), env, ctx);
    // No instruction: proof the request reached handleCompose, not a 404/405.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'instruction is required (max 1000 chars)',
    });
  });

  test('POST /summarize dispatches to the summarize handler (reaches its validation)', async () => {
    const response = await worker.fetch(request('/summarize', { body: '{}' }), env, ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'A valid message id is required' });
  });

  test('POST /document dispatches to the document handler (reaches its validation)', async () => {
    const response = await worker.fetch(request('/document', { body: '{}' }), env, ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'instruction is required (max 1000 chars)',
    });
  });

  test('an unknown path returns 404', async () => {
    const response = await worker.fetch(request('/unknown', { body: '{}' }), env, ctx);
    expect(response.status).toBe(404);
  });

  test('a non-POST method returns 405 with an Allow header', async () => {
    const response = await worker.fetch(request('/compose', { method: 'GET' }), env, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  test('invalid JSON returns 400 after the quota claim, like the Vercel handlers did', async () => {
    const response = await worker.fetch(request('/compose', { body: '{not json' }), env, ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
    expect(allowRequest).toHaveBeenCalledOnce();
  });
});

describe('cleanup', () => {
  test('closes the sql connection on a successful request', async () => {
    await worker.fetch(request('/compose', { body: '{}' }), env, ctx);
    expect(sqlEnd).toHaveBeenCalledOnce();
  });
});
