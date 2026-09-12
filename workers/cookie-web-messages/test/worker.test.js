import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth wiring is what this file tests — the business logic
// (contacts.js/messages.js) already has its own unit tests against a mock
// sql, so the database and @vercel/blob are stubbed here rather than
// exercised.
const mockQuery = vi.fn(
  /** @param {any[]} _args */ (..._args) => Promise.resolve(/** @type {any[]} */ ([])),
);
const sqlEnd = vi.fn(async () => undefined);
const makeClient = () => {
  /** @type {any} */
  const sql = (/** @type {any[]} */ ...args) => mockQuery(...args);
  sql.end = sqlEnd;
  return sql;
};
const createClient = vi.fn(makeClient);
vi.mock('postgres', () => ({
  default: (/** @type {string} */ _databaseUrl) => createClient(),
}));

vi.mock('@vercel/blob', () => ({
  issueSignedToken: vi.fn().mockResolvedValue({ clientSigningToken: 'a', delegationToken: 'b' }),
  presignUrl: vi.fn().mockResolvedValue({ presignedUrl: 'https://blob.vercel-storage.com/signed' }),
  getDownloadUrl: vi.fn((/** @type {string} */ url) => url),
}));

const verifyAccessToken = vi.fn();
vi.mock('../../../shared/auth-jwt.js', () => ({
  verifyAccessToken: (/** @type {any[]} */ ...args) => verifyAccessToken(...args),
  authFailureResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));

const captureHandledException = vi.fn();
vi.mock('../src/sentry.js', () => ({
  createSentryOptions: () => ({ enabled: false }),
  captureHandledException: (/** @type {any[]} */ ...args) => captureHandledException(...args),
}));

vi.mock('../../../shared/rate-limit.js', () => ({
  allowRequest: vi.fn().mockResolvedValue(true),
}));

const worker = (await import('../src/worker.js')).default;

const PRODUCTION = 'https://mail.infinitywave.online';
const env = /** @type {any} */ ({
  HYPERDRIVE: { connectionString: 'postgres://stub' },
  AUTH0_DOMAIN: 'tenant.example.auth0.com',
  AUTH0_AUDIENCE: 'https://cookie-web/api',
  ALLOWED_ORIGIN: PRODUCTION,
  BLOB_READ_WRITE_TOKEN: 'blob-token',
});
const ctx = /** @type {any} */ ({
  waitUntil: (/** @type {Promise<unknown>} */ promise) => promise,
});

/** @param {string} path @param {RequestInit} [init] */
function request(path, init = {}) {
  return new Request(`https://cookie-web-messages.example${path}`, {
    ...init,
    headers: { Origin: PRODUCTION, Authorization: 'Bearer token', ...init.headers },
  });
}

const MESSAGE_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  verifyAccessToken.mockResolvedValue({ userId: 'user-1' });
  mockQuery.mockReset().mockResolvedValue([]);
  createClient.mockImplementation(makeClient);
});

describe('CORS preflight', () => {
  test('answers OPTIONS from an allowed origin without touching auth or the database', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-messages.example/messages', {
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

describe('auth', () => {
  test('rejects a request that fails verification', async () => {
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const response = await worker.fetch(request(`/messages?id=${MESSAGE_ID}`), env, ctx);
    expect(response.status).toBe(401);
  });
});

describe('routing', () => {
  test('GET /messages?id= dispatches to getMessage', async () => {
    const response = await worker.fetch(request(`/messages?id=${MESSAGE_ID}`), env, ctx);
    // Empty mock result -> "not found", but a 200/404 (not 400/404-from-bad-id)
    // proves the id was accepted and getMessage ran.
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Message not found');
  });

  test('GET /messages/attachment dispatches to getAttachment with blob deps wired', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        filename: 'plan.pdf',
        content_type: 'application/pdf',
        blob_url: 'https://store.private.blob.vercel-storage.com/plan.pdf',
      },
    ]);
    const attachmentId = '33333333-3333-3333-3333-333333333333';
    const response = await worker.fetch(
      request(`/messages/attachment?id=${attachmentId}`),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).filename).toBe('plan.pdf');
  });

  test('the retired /messages/thread-body path is 404, like any unknown sub-path', async () => {
    const response = await worker.fetch(
      request(`/messages/thread-body?id=${MESSAGE_ID}`),
      env,
      ctx,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not Found' });
  });

  test('GET /messages/contacts dispatches to getContacts', async () => {
    const response = await worker.fetch(request('/messages/contacts'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ contacts: [] });
  });

  test('POST /messages dispatches to postMessage', async () => {
    const response = await worker.fetch(
      request('/messages', {
        method: 'POST',
        body: JSON.stringify({ id: MESSAGE_ID, action: 'unsubscribe' }),
      }),
      env,
      ctx,
    );
    // The stubbed sql returns no message row, reported as a 404 — proof the
    // request reached postMessage, not a 400/405.
    expect(response.status).toBe(404);
  });

  test('PATCH /messages dispatches to patchMessage', async () => {
    const response = await worker.fetch(
      request('/messages', {
        method: 'PATCH',
        body: JSON.stringify({ id: MESSAGE_ID, is_starred: true }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(404);
  });

  test('an unknown sub-path returns 404', async () => {
    const response = await worker.fetch(request('/messages/unknown'), env, ctx);
    expect(response.status).toBe(404);
  });

  test('a completely unknown top-level path returns 404', async () => {
    const response = await worker.fetch(request('/unknown'), env, ctx);
    expect(response.status).toBe(404);
  });

  test('DELETE on /messages returns 405', async () => {
    const response = await worker.fetch(request('/messages', { method: 'DELETE' }), env, ctx);
    expect(response.status).toBe(405);
  });

  test('POST on /messages/contacts returns 405', async () => {
    const response = await worker.fetch(
      request('/messages/contacts', { method: 'POST' }),
      env,
      ctx,
    );
    expect(response.status).toBe(405);
  });

  test('invalid JSON on POST returns 400 before reaching a handler', async () => {
    const response = await worker.fetch(
      request('/messages', { method: 'POST', body: '{not json' }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
  });
});

describe('cleanup and error reporting', () => {
  test('closes the sql connection on a successful request', async () => {
    await worker.fetch(request('/messages/contacts'), env, ctx);
    expect(sqlEnd).toHaveBeenCalledOnce();
  });

  test('closes the sql connection and reports a 500 when a handler throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    const response = await worker.fetch(request('/messages/contacts'), env, ctx);
    expect(response.status).toBe(500);
    expect(captureHandledException).toHaveBeenCalledOnce();
    expect(sqlEnd).toHaveBeenCalledOnce();
  });

  // The socket to Hyperdrive drops under a query now and then (Sentry
  // COOKIE-WEB-M, -R, -17, and -Z). Reads and PATCH /messages are idempotent,
  // so they get one more go on a fresh connection; POST sends mail and does not.
  describe('a dropped connection', () => {
    const dropped = () => new Error('Network connection lost.');

    test('retries a read once on a fresh connection, and nobody hears of it', async () => {
      mockQuery.mockRejectedValueOnce(dropped()).mockResolvedValue([]);
      const response = await worker.fetch(request('/messages/contacts'), env, ctx);
      expect(response.status).toBe(200);
      expect(createClient).toHaveBeenCalledTimes(2);
      expect(captureHandledException).not.toHaveBeenCalled();
      // The dead connection and the fresh one are both closed.
      expect(sqlEnd).toHaveBeenCalledTimes(2);
    });

    test('gives up after the second drop and reports it', async () => {
      mockQuery.mockRejectedValue(dropped());
      const response = await worker.fetch(request('/messages/contacts'), env, ctx);
      expect(response.status).toBe(500);
      expect(createClient).toHaveBeenCalledTimes(2);
      expect(captureHandledException).toHaveBeenCalledOnce();
    });

    test('retries a PATCH once, replaying its body', async () => {
      mockQuery
        .mockRejectedValueOnce(dropped())
        .mockResolvedValue([{ id: MESSAGE_ID, is_starred: true }]);
      const patchCtx = /** @type {any} */ ({ waitUntil: vi.fn() });
      const response = await worker.fetch(
        request('/messages', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: MESSAGE_ID, is_starred: true }),
        }),
        env,
        patchCtx,
      );
      expect(response.status).toBe(200);
      // The retry opens a fresh request client, then the successful PATCH
      // schedules its own client for search reindexing.
      expect(createClient).toHaveBeenCalledTimes(3);
      expect(captureHandledException).not.toHaveBeenCalled();
      expect((await response.json()).message.is_starred).toBe(true);
    });

    test('does not retry a POST', async () => {
      mockQuery.mockRejectedValueOnce(dropped()).mockResolvedValue([]);
      const response = await worker.fetch(
        request('/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: MESSAGE_ID,
            action: 'unsubscribe',
            to: 'a@b.c',
            subject: 's',
            body: 'b',
          }),
        }),
        env,
        ctx,
      );
      expect(response.status).toBe(500);
      expect(createClient).toHaveBeenCalledOnce();
      expect(captureHandledException).toHaveBeenCalledOnce();
    });

    test('retries the caller lookup too, rather than answering 401', async () => {
      verifyAccessToken.mockRejectedValueOnce(dropped()).mockResolvedValue({ userId: 'user-1' });
      const response = await worker.fetch(request('/messages/contacts'), env, ctx);
      expect(response.status).toBe(200);
      expect(createClient).toHaveBeenCalledTimes(2);
    });

    test('does not retry a read that failed for another reason', async () => {
      mockQuery.mockRejectedValueOnce(new Error('syntax error')).mockResolvedValue([]);
      const response = await worker.fetch(request('/messages/contacts'), env, ctx);
      expect(response.status).toBe(500);
      expect(createClient).toHaveBeenCalledOnce();
    });
  });
});

describe('search reindex after a write', () => {
  /** Collects the waitUntil work so a test can await it. @returns {any} */
  function collectingCtx() {
    /** @type {Promise<unknown>[]} */
    const pending = [];
    return {
      pending,
      waitUntil: (/** @type {Promise<unknown>} */ promise) => pending.push(promise),
    };
  }

  test('a successful PATCH reindexes on a client of its own', async () => {
    mockQuery.mockResolvedValueOnce([{ id: MESSAGE_ID, is_archived: true }]);
    const patchCtx = collectingCtx();
    const response = await worker.fetch(
      request('/messages', {
        method: 'PATCH',
        body: JSON.stringify({ id: MESSAGE_ID, is_archived: true }),
      }),
      env,
      patchCtx,
    );
    expect(response.status).toBe(200);
    await Promise.all(patchCtx.pending);
    // Two clients: the request-scoped one, which fetch's `finally` closes the
    // moment the route returns, and a second one owned by the reindex. The
    // sync must never borrow the first — it would be querying a closing
    // connection. Both are closed.
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(sqlEnd).toHaveBeenCalledTimes(2);
  });

  test('a PATCH that matched no row opens no second client', async () => {
    const patchCtx = collectingCtx();
    const response = await worker.fetch(
      request('/messages', {
        method: 'PATCH',
        body: JSON.stringify({ id: MESSAGE_ID, is_archived: true }),
      }),
      env,
      patchCtx,
    );
    expect(response.status).toBe(404);
    await Promise.all(patchCtx.pending);
    expect(createClient).toHaveBeenCalledOnce();
  });

  // Indexing must never fail, delay or change a user-visible response. createSql
  // throws synchronously on an invalid connection string, so without a catch the
  // waitUntil work would reject unhandled on every PATCH.
  test('a reindex that cannot open a client settles instead of rejecting', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockQuery.mockResolvedValueOnce([{ id: MESSAGE_ID, is_archived: true }]);
    // The request-scoped client opens normally; the reindex's own client is the
    // second, and it cannot be created.
    createClient.mockImplementationOnce(makeClient).mockImplementationOnce(() => {
      throw new Error('invalid connection string');
    });

    const patchCtx = collectingCtx();
    const response = await worker.fetch(
      request('/messages', {
        method: 'PATCH',
        body: JSON.stringify({ id: MESSAGE_ID, is_archived: true }),
      }),
      env,
      patchCtx,
    );

    expect(response.status).toBe(200);
    await expect(Promise.all(patchCtx.pending)).resolves.toBeDefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('failed to index message for search'),
      'invalid connection string',
    );
    consoleError.mockRestore();
  });
});
