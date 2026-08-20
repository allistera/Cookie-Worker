import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth wiring is what this file tests — the business logic
// (contacts.js/messages.js) already has its own unit tests against a mock
// sql, so the database and @vercel/blob are stubbed here rather than
// exercised.
const mockQuery = vi.fn(/** @param {any[]} _args */ (..._args) => Promise.resolve(/** @type {any[]} */ ([])));
const sqlEnd = vi.fn(async () => undefined);
vi.mock('postgres', () => ({
  default: () => {
    /** @type {any} */
    const sql = (/** @type {any[]} */ ...args) => mockQuery(...args);
    sql.end = sqlEnd;
    return sql;
  },
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

const worker = (await import('../src/worker.js')).default;

const PRODUCTION = 'https://mail.infinitywave.online';
const env = /** @type {any} */ ({
  HYPERDRIVE: { connectionString: 'postgres://stub' },
  AUTH0_DOMAIN: 'tenant.example.auth0.com',
  AUTH0_AUDIENCE: 'https://cookie-web/api',
  ALLOWED_ORIGIN: PRODUCTION,
  BLOB_READ_WRITE_TOKEN: 'blob-token',
});
const ctx = /** @type {any} */ ({ waitUntil: (/** @type {Promise<unknown>} */ promise) => promise });

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
});

describe('CORS preflight', () => {
  test('answers OPTIONS from an allowed origin without touching auth or the database', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-messages.example/messages', { method: 'OPTIONS', headers: { Origin: PRODUCTION } }),
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
      { filename: 'plan.pdf', content_type: 'application/pdf', blob_url: 'https://store.private.blob.vercel-storage.com/plan.pdf' },
    ]);
    const attachmentId = '33333333-3333-3333-3333-333333333333';
    const response = await worker.fetch(request(`/messages/attachment?id=${attachmentId}`), env, ctx);
    expect(response.status).toBe(200);
    expect((await response.json()).filename).toBe('plan.pdf');
  });

  test('GET /messages/thread-body dispatches to getThreadBody', async () => {
    const response = await worker.fetch(request(`/messages/thread-body?id=${MESSAGE_ID}`), env, ctx);
    expect(response.status).toBe(404);
  });

  test('GET /messages/contacts dispatches to getContacts', async () => {
    const response = await worker.fetch(request('/messages/contacts'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ contacts: [] });
  });

  test('POST /messages dispatches to postMessage', async () => {
    const response = await worker.fetch(
      request('/messages', { method: 'POST', body: JSON.stringify({ id: MESSAGE_ID, action: 'unsubscribe' }) }),
      env,
      ctx,
    );
    // The stubbed sql returns no message row, reported as a 404 — proof the
    // request reached postMessage, not a 400/405.
    expect(response.status).toBe(404);
  });

  test('PATCH /messages dispatches to patchMessage', async () => {
    const response = await worker.fetch(
      request('/messages', { method: 'PATCH', body: JSON.stringify({ id: MESSAGE_ID, is_starred: true }) }),
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
    const response = await worker.fetch(request('/messages/contacts', { method: 'POST' }), env, ctx);
    expect(response.status).toBe(405);
  });

  test('invalid JSON on POST returns 400 before reaching a handler', async () => {
    const response = await worker.fetch(request('/messages', { method: 'POST', body: '{not json' }), env, ctx);
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
});
