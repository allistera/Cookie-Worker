import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth wiring is what this file tests — the business logic
// (notificationEvents.js) already has its own unit tests against a mock sql,
// so the database itself is stubbed here rather than exercised. mockQuery is
// reset in beforeEach and can be overridden per test (e.g. to make a
// handler's query throw, for the error-reporting tests below).
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

const EVENT_ID = '11111111-1111-1111-1111-111111111111';

/** @param {string} path @param {RequestInit} [init] */
function request(path, init = {}) {
  return new Request(`https://cookie-web-notifications.example${path}`, {
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
      new Request('https://cookie-web-notifications.example/notification-event', {
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

  test('rejects OPTIONS from a disallowed origin', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-notifications.example/notification-event', {
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
    const response = await worker.fetch(
      request('/notification-event', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(response.status).toBe(401);
  });

  test('CORS headers are still applied to a 401', async () => {
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const response = await worker.fetch(
      request('/notification-event', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
  });
});

describe('routing', () => {
  test('GET /ntfy returns the authenticated user subscription', async () => {
    mockQuery.mockResolvedValueOnce([{ topic: 'cookie-topic', enabled: true }]);
    const response = await worker.fetch(request('/ntfy'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      topic: 'cookie-topic',
      subscribeUrl: 'https://ntfy.sh/cookie-topic',
      enabled: true,
    });
  });

  test('POST /ntfy creates a subscription without exposing another user', async () => {
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ topic: 'cookie-generated-topic', enabled: true }]);
    const response = await worker.fetch(
      request('/ntfy', { method: 'POST', body: JSON.stringify({}) }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      topic: 'cookie-generated-topic',
      subscribeUrl: 'https://ntfy.sh/cookie-generated-topic',
      enabled: true,
    });
  });

  test('DELETE /ntfy disables the authenticated user subscription', async () => {
    const response = await worker.fetch(request('/ntfy', { method: 'DELETE' }), env, ctx);
    expect(response.status).toBe(204);
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][0].join(' ')).toContain('UPDATE ntfy_subscriptions');
  });

  test('POST /notification-event dispatches to the handler (reaches its validation)', async () => {
    const response = await worker.fetch(
      request('/notification-event', {
        method: 'POST',
        body: JSON.stringify({ action: 'claim', eventId: EVENT_ID }),
      }),
      env,
      ctx,
    );
    // The stubbed sql returns no row for the claim or the lease lookup, which
    // the handler reports as 204 — proof the request reached it, not a 404/405.
    expect(response.status).toBe(204);
  });

  test('an unknown path returns 404', async () => {
    const response = await worker.fetch(request('/unknown', { method: 'POST' }), env, ctx);
    expect(response.status).toBe(404);
  });

  test('a non-POST method returns 405 with an Allow header', async () => {
    const response = await worker.fetch(request('/notification-event'), env, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  test('invalid JSON returns 400 before reaching the handler', async () => {
    const response = await worker.fetch(
      request('/notification-event', { method: 'POST', body: '{not json' }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('cleanup and error reporting', () => {
  test('closes the sql connection on a successful request', async () => {
    await worker.fetch(
      request('/notification-event', {
        method: 'POST',
        body: JSON.stringify({ action: 'claim', eventId: EVENT_ID }),
      }),
      env,
      ctx,
    );
    expect(sqlEnd).toHaveBeenCalledOnce();
  });

  test('closes the sql connection and reports a 500 when a handler throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    const response = await worker.fetch(
      request('/notification-event', {
        method: 'POST',
        body: JSON.stringify({ action: 'claim', eventId: EVENT_ID }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(500);
    expect(captureHandledException).toHaveBeenCalledOnce();
    expect(sqlEnd).toHaveBeenCalledOnce();
  });
});
