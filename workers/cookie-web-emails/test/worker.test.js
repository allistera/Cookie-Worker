import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth wiring is what this file tests — the business logic
// (emails.js) already has its own unit tests against a stub sql, so the
// database itself is stubbed here rather than exercised.
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
    sql.json = (/** @type {unknown} */ value) => value;
    return sql;
  },
}));

const verifyAccessToken = vi.fn();
vi.mock('../../../shared/auth-jwt.js', () => ({
  verifyAccessToken: (...args) => verifyAccessToken(...args),
  authFailureResponse: (/** @type {any} */ error) =>
    Response.json({ error: 'Unauthorized' }, { status: error?.status ?? 401 }),
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

/** @param {string} path @param {RequestInit} [init] */
function request(path, init = {}) {
  return new Request(`https://cookie-web-emails.example${path}`, {
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
      new Request('https://cookie-web-emails.example/emails', {
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

describe('auth', () => {
  test('rejects a request that fails verification, without dispatching to a handler', async () => {
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const response = await worker.fetch(request('/emails'), env, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
  });
});

describe('routing', () => {
  test('sender settings use the verified owner, reject invalid mutations, and require authentication', async () => {
    mockQuery.mockImplementation((strings) =>
      Promise.resolve(strings.join('').includes('FROM users') ? [{ enabled: false }] : []),
    );
    const response = await worker.fetch(request('/emails/senders?userId=someone-else'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, decisions: [], nextCursor: null });
    expect(mockQuery.mock.calls[0]).toContain('user-1');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const invalid = await worker.fetch(
      request('/emails/senders', { method: 'PUT', body: '{"action":"settings","enabled":"true"}' }),
      env,
      ctx,
    );
    expect(invalid.status).toBe(400);
    const method = await worker.fetch(
      request('/emails/senders', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(method.status).toBe(405);
    const count = mockQuery.mock.calls.length;
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    expect((await worker.fetch(request('/emails/senders'), env, ctx)).status).toBe(401);
    expect(mockQuery).toHaveBeenCalledTimes(count);
  });

  test('out-of-office settings require the verified owner and default to off', async () => {
    mockQuery.mockResolvedValueOnce([{ settings: null }]).mockResolvedValueOnce([]);
    const response = await worker.fetch(request('/emails/out-of-office'), env, ctx);
    expect(response.status).toBe(200);
    expect((await response.json()).enabled).toBe(false);
    expect(mockQuery.mock.calls[0]).toContain('user-1');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const denied = await worker.fetch(
      request('/emails/out-of-office', { method: 'PUT', body: '{"action":"stop"}' }),
      env,
      ctx,
    );
    expect(denied.status).toBe(401);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test('out-of-office settings reject unsupported methods and invalid dates', async () => {
    const method = await worker.fetch(
      request('/emails/out-of-office', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(method.status).toBe(405);
    expect(method.headers.get('Allow')).toBe('GET, PUT');
    const invalid = await worker.fetch(
      request('/emails/out-of-office', {
        method: 'PUT',
        body: '{"revision":0,"enabled":true,"startDate":"2026-02-30"}',
      }),
      env,
      ctx,
    );
    expect(invalid.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('GET /emails/auto-archive returns opt-in defaults for the authenticated user', async () => {
    const response = await worker.fetch(request('/emails/auto-archive'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      autoArchive: { marketing: false, coldPitches: false, socialNoise: false },
    });
    expect(mockQuery.mock.calls[0]).toContain('user-1');
  });

  test('PUT /emails/auto-archive validates the body and methods are restricted', async () => {
    const invalid = await worker.fetch(
      request('/emails/auto-archive', { method: 'PUT', body: '{}' }),
      env,
      ctx,
    );
    expect(invalid.status).toBe(400);
    const method = await worker.fetch(
      request('/emails/auto-archive', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(method.status).toBe(405);
    expect(method.headers.get('Allow')).toBe('GET, PUT');
  });

  test('GET /emails dispatches to the list handler', async () => {
    const response = await worker.fetch(request('/emails'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      emails: [],
      nextCursor: null,
      unreadCount: 0,
      spamCount: 0,
      snoozedCount: 0,
      userId: 'user-1',
    });
  });

  test('GET /emails/state dispatches to the state handler', async () => {
    mockQuery.mockResolvedValueOnce([{ unread: 3 }]);
    const response = await worker.fetch(request('/emails/state'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      unreadCount: 3,
      spamCount: 0,
      snoozedCount: 0,
      scheduledCount: 0,
      starredCount: 0,
      screeningCount: 0,
      blockedCount: 0,
      userId: 'user-1',
    });
  });

  test('GET /emails/spam-retention returns the stored preference with its bounds', async () => {
    mockQuery.mockResolvedValueOnce([{ days: 14 }]);
    const response = await worker.fetch(request('/emails/spam-retention'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      spamRetentionDays: 14,
      defaultDays: 30,
      minDays: 1,
      maxDays: 365,
    });
  });

  test('GET /emails/compose-preferences requires auth and uses the verified user', async () => {
    mockQuery.mockResolvedValueOnce([{ preferences: null }]);
    const response = await worker.fetch(request('/emails/compose-preferences'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 0, signatureHtml: '', snippets: [] });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockQuery.mock.calls[0]).toContain('user-1');
  });

  test('PUT /emails/compose-preferences rejects an invalid document before querying', async () => {
    const response = await worker.fetch(
      request('/emails/compose-preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: 0, signatureHtml: '', snippets: [{ name: 'bad' }] }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('PUT /emails/spam-retention stores a new retention', async () => {
    mockQuery.mockResolvedValueOnce([{ days: 60 }]);
    const response = await worker.fetch(
      request('/emails/spam-retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spamRetentionDays: 60 }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).spamRetentionDays).toBe(60);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('PUT /emails/spam-retention rejects a malformed body before touching the database', async () => {
    const response = await worker.fetch(
      request('/emails/spam-retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('other methods on /emails/spam-retention return 405 allowing GET and PUT', async () => {
    const response = await worker.fetch(
      request('/emails/spam-retention', { method: 'POST' }),
      env,
      ctx,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, PUT');
  });

  test('an unknown path returns 404', async () => {
    const response = await worker.fetch(request('/emails/unknown'), env, ctx);
    expect(response.status).toBe(404);
  });

  test('a non-GET method returns 405 with an Allow header', async () => {
    const response = await worker.fetch(request('/emails', { method: 'POST' }), env, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
  });
});

describe('cleanup', () => {
  test('closes the sql connection on a successful request', async () => {
    await worker.fetch(request('/emails'), env, ctx);
    expect(sqlEnd).toHaveBeenCalledOnce();
  });
});

// The socket to Hyperdrive drops under a query now and then; GET /emails is
// the busiest read, so reads get one more go on a fresh connection.
describe('a dropped connection', () => {
  const dropped = () => new Error('Network connection lost.');

  test('retries a read once on a fresh connection, and nobody hears of it', async () => {
    mockQuery.mockRejectedValueOnce(dropped()).mockResolvedValue([{ days: 14 }]);
    const response = await worker.fetch(request('/emails/spam-retention'), env, ctx);
    expect(response.status).toBe(200);
    expect((await response.json()).spamRetentionDays).toBe(14);
    expect(captureHandledException).not.toHaveBeenCalled();
    // The dead connection and the fresh one are both closed.
    expect(sqlEnd).toHaveBeenCalledTimes(2);
  });

  test('does not retry a write', async () => {
    mockQuery.mockRejectedValueOnce(dropped()).mockResolvedValue([{ days: 60 }]);
    const response = await worker.fetch(
      request('/emails/spam-retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spamRetentionDays: 60 }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(500);
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(captureHandledException).toHaveBeenCalledOnce();
  });

  // Mirrors AuthFailure('Mailbox lookup failed', 503, {cause}) from auth-jwt.
  const droppedLookup = () =>
    Object.assign(new Error('Mailbox lookup failed', { cause: dropped() }), { status: 503 });

  test('a write whose mailbox lookup drops stays a 503 and is not reported', async () => {
    verifyAccessToken.mockRejectedValue(droppedLookup());
    const response = await worker.fetch(
      request('/emails/spam-retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spamRetentionDays: 60 }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(503);
    expect(verifyAccessToken).toHaveBeenCalledOnce();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(captureHandledException).not.toHaveBeenCalled();
  });

  test('a read whose mailbox lookup drops twice ends as a 503, not a 500', async () => {
    verifyAccessToken.mockRejectedValue(droppedLookup());
    const response = await worker.fetch(request('/emails/spam-retention'), env, ctx);
    expect(response.status).toBe(503);
    expect(verifyAccessToken).toHaveBeenCalledTimes(2);
    expect(captureHandledException).not.toHaveBeenCalled();
  });

  test('does not retry a read that failed for another reason', async () => {
    mockQuery.mockRejectedValueOnce(new Error('syntax error')).mockResolvedValue([]);
    const response = await worker.fetch(request('/emails/spam-retention'), env, ctx);
    expect(response.status).toBe(500);
    expect(mockQuery).toHaveBeenCalledOnce();
  });
});
