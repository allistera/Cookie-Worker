import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth wiring is what this file tests — the business logic
// (labels.js/labelRules.js) already has its own unit tests against a mock
// sql, so the database itself is stubbed here rather than exercised.
// mockQuery is reset in beforeEach and can be overridden per test (e.g. to
// make a handler's query throw, for the error-reporting tests below).
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
vi.mock('../../../shared/auth-jwt.js', () => ({ verifyAccessToken: (...args) => verifyAccessToken(...args) }));

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
const ctx = /** @type {any} */ ({ waitUntil: (promise) => promise });

/** @param {string} path @param {RequestInit} [init] */
function request(path, init = {}) {
  return new Request(`https://cookie-web-labels.example${path}`, {
    ...init,
    headers: { Origin: PRODUCTION, Authorization: 'Bearer token', ...init.headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyAccessToken.mockResolvedValue({ userId: 'user-1' });
  mockQuery.mockReset().mockResolvedValue([]);
});

describe('CORS preflight', () => {
  test('answers OPTIONS from an allowed origin without touching auth or the database', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-labels.example/labels', { method: 'OPTIONS', headers: { Origin: PRODUCTION } }),
      env,
      ctx,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  test('rejects OPTIONS from a disallowed origin', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-labels.example/labels', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example.com' },
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(403);
  });
});

describe('auth', () => {
  test('rejects a request that fails verification, without dispatching to a handler', async () => {
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const response = await worker.fetch(request('/labels'), env, ctx);
    expect(response.status).toBe(401);
  });

  test('CORS headers are still applied to a 401', async () => {
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const response = await worker.fetch(request('/labels'), env, ctx);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
  });
});

describe('routing', () => {
  test('GET /labels dispatches to listLabels', async () => {
    const response = await worker.fetch(request('/labels'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ labels: [] });
  });

  test('GET /labels/rules dispatches to listRules', async () => {
    const response = await worker.fetch(request('/labels/rules'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rules: [] });
  });

  test('POST /labels dispatches to createLabel (reaches its validation)', async () => {
    const response = await worker.fetch(
      request('/labels', { method: 'POST', body: JSON.stringify({ name: 'Work', color: '#2F6BE0' }) }),
      env,
      ctx,
    );
    // The stubbed sql returns no row for the INSERT, which createLabel reports
    // as a conflict — proof the request reached createLabel, not a 404/405.
    expect(response.status).toBe(409);
  });

  test('an unknown path returns 404', async () => {
    const response = await worker.fetch(request('/unknown'), env, ctx);
    expect(response.status).toBe(404);
  });

  test('an unsupported method on a known path returns 405', async () => {
    const response = await worker.fetch(request('/labels', { method: 'PUT' }), env, ctx);
    expect(response.status).toBe(405);
  });

  test('invalid JSON returns 400 before reaching a handler', async () => {
    const response = await worker.fetch(request('/labels', { method: 'POST', body: '{not json' }), env, ctx);
    expect(response.status).toBe(400);
  });
});

describe('cleanup and error reporting', () => {
  test('closes the sql connection on a successful request', async () => {
    await worker.fetch(request('/labels'), env, ctx);
    expect(sqlEnd).toHaveBeenCalledOnce();
  });

  test('closes the sql connection and reports a 500 when a handler throws', async () => {
    // updateLabel's UPDATE query throws for any error other than a 23505
    // (duplicate-name) conflict, which it catches itself — this is the
    // genuine "escaped the handler" path the outer try/catch exists for.
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    const response = await worker.fetch(
      request('/labels', {
        method: 'PATCH',
        body: JSON.stringify({ id: '11111111-1111-1111-1111-111111111111', name: 'Renamed' }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(500);
    expect(captureHandledException).toHaveBeenCalledOnce();
    expect(sqlEnd).toHaveBeenCalledOnce();
  });
});
