import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
  NTFY_BASE_URL: 'https://ntfy.allisterantosik.com',
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

afterEach(() => {
  vi.unstubAllGlobals();
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
  const SUBSCRIPTION_ROW = {
    server_url: 'https://ntfy.sh',
    topic: 'cookie-topic',
    enabled: true,
    token_hint: 'cret',
    access_token_encrypted: 'v1:ciphertext',
  };

  test('GET /ntfy returns the authenticated user subscription without its token', async () => {
    mockQuery.mockResolvedValueOnce([SUBSCRIPTION_ROW]);
    const response = await worker.fetch(request('/ntfy'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: true,
      defaultServerUrl: 'https://ntfy.allisterantosik.com',
      tokensSupported: false,
      serverUrl: 'https://ntfy.sh',
      topic: 'cookie-topic',
      subscribeUrl: 'https://ntfy.sh/cookie-topic',
      tokenHint: 'cret',
    });
  });

  test('GET /ntfy tells Settings when a user has not set ntfy up', async () => {
    const response = await worker.fetch(
      request('/ntfy'),
      { ...env, NTFY_TOKEN_ENCRYPTION_KEY: 'key' },
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: false,
      defaultServerUrl: 'https://ntfy.allisterantosik.com',
      tokensSupported: true,
    });
  });

  test('PUT /ntfy saves the server and topic the user entered', async () => {
    mockQuery.mockResolvedValueOnce([
      { ...SUBSCRIPTION_ROW, token_hint: '', access_token_encrypted: null },
    ]);
    const response = await worker.fetch(
      request('/ntfy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl: 'https://ntfy.sh', topic: 'cookie-topic' }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: true,
      subscribeUrl: 'https://ntfy.sh/cookie-topic',
      tokenHint: '',
    });
    expect(mockQuery.mock.calls[0][0].join(' ')).toContain('INSERT INTO ntfy_subscriptions');
    expect(mockQuery.mock.calls[0].slice(1)).toEqual(['user-1', 'https://ntfy.sh', 'cookie-topic']);
  });

  test('PUT /ntfy rejects an unusable server URL before writing', async () => {
    const response = await worker.fetch(
      request('/ntfy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl: 'http://ntfy.sh', topic: 'cookie-topic' }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_server_url',
      message: 'Enter the https:// address of an ntfy server.',
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('PUT /ntfy reports a token as unsupported when no encryption key is set', async () => {
    const response = await worker.fetch(
      request('/ntfy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverUrl: 'https://ntfy.sh',
          topic: 'cookie-topic',
          accessToken: 'tk_secret',
        }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: 'tokens_not_configured' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('PUT /ntfy reports a topic another account holds on that server', async () => {
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
    const response = await worker.fetch(
      request('/ntfy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl: 'https://ntfy.sh', topic: 'cookie-topic' }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'topic_taken' });
    expect(captureHandledException).not.toHaveBeenCalled();
  });

  test('PUT /ntfy rejects a non-object body', async () => {
    const response = await worker.fetch(
      request('/ntfy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '[]',
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('POST /ntfy still creates a generated topic on the default server', async () => {
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        server_url: 'https://ntfy.allisterantosik.com',
        topic: 'cookie-generated-topic',
        enabled: true,
        token_hint: '',
        access_token_encrypted: null,
      },
    ]);
    const response = await worker.fetch(
      request('/ntfy', { method: 'POST', body: JSON.stringify({}) }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: true,
      defaultServerUrl: 'https://ntfy.allisterantosik.com',
      tokensSupported: false,
      serverUrl: 'https://ntfy.allisterantosik.com',
      topic: 'cookie-generated-topic',
      subscribeUrl: 'https://ntfy.allisterantosik.com/cookie-generated-topic',
      tokenHint: '',
    });
  });

  test('DELETE /ntfy disables the authenticated user subscription', async () => {
    const response = await worker.fetch(request('/ntfy', { method: 'DELETE' }), env, ctx);
    expect(response.status).toBe(204);
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][0].join(' ')).toContain('UPDATE ntfy_subscriptions');
  });

  test('POST /ntfy/test sends a test notification to the user server', async () => {
    mockQuery.mockResolvedValueOnce([
      { server_url: 'https://ntfy.sh', topic: 'cookie-user-topic', access_token_encrypted: null },
    ]);
    const ntfyFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', ntfyFetch);

    const response = await worker.fetch(request('/ntfy/test', { method: 'POST' }), env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    expect(ntfyFetch).toHaveBeenCalledWith('https://ntfy.sh/cookie-user-topic', expect.any(Object));
  });

  test('POST /ntfy/test never falls back to the public ntfy service', async () => {
    mockQuery.mockResolvedValueOnce([{ topic: 'cookie-user-topic' }]);
    const ntfyFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', ntfyFetch);

    await worker.fetch(
      request('/ntfy/test', { method: 'POST' }),
      { ...env, NTFY_BASE_URL: '' },
      ctx,
    );

    expect(ntfyFetch).toHaveBeenCalledWith(
      'https://ntfy.allisterantosik.com/cookie-user-topic',
      expect.any(Object),
    );
  });

  test('POST /ntfy/test reports when notifications are not enabled', async () => {
    const response = await worker.fetch(request('/ntfy/test', { method: 'POST' }), env, ctx);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'ntfy notifications are not enabled' });
  });

  test('POST /ntfy/test reports exhausted upstream rate limiting as retryable', async () => {
    mockQuery.mockResolvedValueOnce([{ topic: 'cookie-user-topic' }]);
    const ntfyFetch = vi
      .fn()
      .mockResolvedValue(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }),
      );
    vi.stubGlobal('fetch', ntfyFetch);

    const response = await worker.fetch(request('/ntfy/test', { method: 'POST' }), env, ctx);

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('0');
    expect(await response.json()).toEqual({
      error: 'ntfy_rate_limited',
      retryAfterSeconds: 0,
    });
    expect(ntfyFetch).toHaveBeenCalledTimes(3);
  });

  test('POST /ntfy/test reports an exhausted upstream outage as retryable', async () => {
    mockQuery.mockResolvedValueOnce([{ topic: 'cookie-user-topic' }]);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('unavailable', { status: 503, headers: { 'Retry-After': '0' } }),
        ),
    );

    const response = await worker.fetch(request('/ntfy/test', { method: 'POST' }), env, ctx);

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('0');
    expect(await response.json()).toEqual({ error: 'ntfy_unavailable' });
  });

  test('POST /ntfy/test reports a non-retryable provider rejection as a bad gateway', async () => {
    mockQuery.mockResolvedValueOnce([{ topic: 'cookie-user-topic' }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rejected', { status: 400 })));

    const response = await worker.fetch(request('/ntfy/test', { method: 'POST' }), env, ctx);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'ntfy_rejected' });
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

// The socket to Hyperdrive drops under a query now and then; reads get one
// more go on a fresh connection, writes do not.
describe('a dropped connection', () => {
  const dropped = () => new Error('Network connection lost.');

  test('retries a read once on a fresh connection, and nobody hears of it', async () => {
    mockQuery
      .mockRejectedValueOnce(dropped())
      .mockResolvedValueOnce([
        { server_url: 'https://ntfy.sh', topic: 'cookie-topic', enabled: true },
      ]);
    const response = await worker.fetch(request('/ntfy'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ topic: 'cookie-topic', enabled: true });
    expect(captureHandledException).not.toHaveBeenCalled();
    // The dead connection and the fresh one are both closed.
    expect(sqlEnd).toHaveBeenCalledTimes(2);
  });

  test('does not retry a write', async () => {
    mockQuery.mockRejectedValueOnce(dropped()).mockResolvedValue([]);
    const response = await worker.fetch(request('/ntfy', { method: 'DELETE' }), env, ctx);
    expect(response.status).toBe(500);
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(captureHandledException).toHaveBeenCalledOnce();
  });
});
