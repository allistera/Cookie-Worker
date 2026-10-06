import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth wiring is what this file tests — the business logic
// (readReceipts.js) already has its own unit tests against a mock sql, so the
// database itself is stubbed here rather than exercised. mockQuery is reset
// in beforeEach and can be overridden per test.
const mockQuery = vi.fn(/** @param {any[]} _args */ (..._args) => Promise.resolve([]));
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
});
/** @type {Promise<unknown>[]} */
let pending = [];
const ctx = /** @type {any} */ ({
  waitUntil: (/** @type {Promise<unknown>} */ promise) => {
    pending.push(promise);
  },
});
/** Awaits the work the worker handed to waitUntil (the pixel's write, closes). */
const settled = () => Promise.all(pending);

const TOKEN = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';

/** @param {string} path @param {RequestInit} [init] */
function request(path, init = {}) {
  return new Request(`https://cookie-web-receipts.example${path}`, {
    ...init,
    headers: { Origin: PRODUCTION, Authorization: 'Bearer token', ...init.headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pending = [];
  verifyAccessToken.mockResolvedValue({ userId: 'user-1' });
  mockQuery.mockReset().mockResolvedValue([]);
});

describe('CORS preflight', () => {
  test('answers OPTIONS from an allowed origin without touching auth or the database', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-receipts.example/read-receipts', {
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

describe('pixel path', () => {
  test('serves the pixel without authenticating — email clients hold no token', async () => {
    const response = await worker.fetch(
      // No Origin, no Authorization: exactly what an email client sends.
      new Request(`https://cookie-web-receipts.example/read-receipts?token=${TOKEN}`, {
        headers: { 'CF-Connecting-IP': '203.0.113.50' },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    expect(verifyAccessToken).not.toHaveBeenCalled();
    await settled();
    expect(mockQuery).toHaveBeenCalledOnce();
  });

  test('an invalid token still gets the identical pixel, with no database call', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-receipts.example/read-receipts?token=nope', {
        headers: { 'CF-Connecting-IP': '203.0.113.51' },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    await settled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(sqlEnd).not.toHaveBeenCalled();
  });

  test('a failed write still gets the pixel, with no 500 and no Sentry report', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request(`https://cookie-web-receipts.example/read-receipts?token=${TOKEN}`, {
        headers: { 'CF-Connecting-IP': '203.0.113.53' },
      }),
      env,
      ctx,
    );
    await settled();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/gif');
    expect(captureHandledException).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(sqlEnd).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});

describe('status path', () => {
  test('rejects a request that fails verification, without dispatching to a handler', async () => {
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const response = await worker.fetch(
      request(`/read-receipts?messageIds=${MESSAGE_ID}`),
      env,
      ctx,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
  });

  test('GET /read-receipts?messageIds dispatches to the status handler', async () => {
    const response = await worker.fetch(
      request(`/read-receipts?messageIds=${MESSAGE_ID}`),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receipts: [] });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
  });

  test('invalid messageIds return 400 without touching the database', async () => {
    const response = await worker.fetch(request('/read-receipts?messageIds=nope'), env, ctx);
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('routing', () => {
  test('an unknown path returns 404', async () => {
    const response = await worker.fetch(request('/unknown'), env, ctx);
    expect(response.status).toBe(404);
  });

  test('a non-GET method returns 405 with an Allow header', async () => {
    const response = await worker.fetch(request('/read-receipts', { method: 'POST' }), env, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });
});

describe('cleanup', () => {
  test('closes the sql connection on both the pixel and status paths', async () => {
    await worker.fetch(
      new Request(`https://cookie-web-receipts.example/read-receipts?token=${TOKEN}`, {
        headers: { 'CF-Connecting-IP': '203.0.113.52' },
      }),
      env,
      ctx,
    );
    await worker.fetch(request(`/read-receipts?messageIds=${MESSAGE_ID}`), env, ctx);
    await settled();
    expect(sqlEnd).toHaveBeenCalledTimes(2);
  });
});

// The socket to Hyperdrive drops under a query now and then: the caller
// lookup or the status query itself gets one more go on a fresh connection
// rather than a spurious 503 (or, for the query, an "unopened" empty list).
describe('a dropped connection', () => {
  test('retries a dropped status query on a fresh connection', async () => {
    const receipt = { message_id: MESSAGE_ID, opened_at: '2026-10-01T09:00:00Z' };
    verifyAccessToken.mockResolvedValue({ userId: 'user-1' });
    mockQuery
      .mockRejectedValueOnce(new Error('Network connection lost.'))
      .mockResolvedValueOnce(/** @type {any} */ ([receipt]));
    const response = await worker.fetch(
      request(`/read-receipts?messageIds=${MESSAGE_ID}`),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(captureHandledException).not.toHaveBeenCalled();
  });

  test('surfaces a non-transient status query failure instead of an empty list', async () => {
    verifyAccessToken.mockResolvedValue({ userId: 'user-1' });
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('syntax error'), { code: '42601' }));
    const response = await worker.fetch(
      request(`/read-receipts?messageIds=${MESSAGE_ID}`),
      env,
      ctx,
    );
    expect(response.status).toBe(500);
    expect(captureHandledException).toHaveBeenCalledOnce();
  });

  test('retries the caller lookup once on a fresh connection', async () => {
    verifyAccessToken
      .mockRejectedValueOnce(new Error('Network connection lost.'))
      .mockResolvedValueOnce({ userId: 'user-1' });
    const response = await worker.fetch(
      request(`/read-receipts?messageIds=${MESSAGE_ID}`),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receipts: [] });
    expect(verifyAccessToken).toHaveBeenCalledTimes(2);
    expect(captureHandledException).not.toHaveBeenCalled();
    await settled();
    expect(sqlEnd).toHaveBeenCalledTimes(2);
  });
});
