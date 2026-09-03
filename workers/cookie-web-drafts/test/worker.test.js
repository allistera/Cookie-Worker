import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth/rate-limit wiring is what this file tests — the draft
// logic itself has its own unit tests against a mock sql, so the database is
// stubbed here rather than exercised.
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

const allowRequest = vi.fn();
vi.mock('../../../shared/rate-limit.js', () => ({
  allowRequest: (...args) => allowRequest(...args),
}));

vi.mock('../src/sentry.js', () => ({
  createSentryOptions: () => ({ enabled: false }),
  captureHandledException: vi.fn(),
}));

const worker = (await import('../src/worker.js')).default;

const PRODUCTION = 'https://mail.infinitywave.online';
const DRAFT_ID = '11111111-1111-1111-1111-111111111111';
const env = /** @type {any} */ ({
  HYPERDRIVE: { connectionString: 'postgres://stub' },
  AUTH0_DOMAIN: 'tenant.example.auth0.com',
  AUTH0_AUDIENCE: 'https://cookie-web/api',
  ALLOWED_ORIGIN: PRODUCTION,
});
const ctx = /** @type {any} */ ({ waitUntil: (promise) => promise });

/** @param {string} path @param {RequestInit} [init] */
function request(path, init = {}) {
  return new Request(`https://cookie-web-drafts.example${path}`, {
    ...init,
    headers: { Origin: PRODUCTION, Authorization: 'Bearer token', ...init.headers },
  });
}

const autosave = (body) => ({
  method: 'PATCH',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.clearAllMocks();
  verifyAccessToken.mockResolvedValue({ userId: 'user-1' });
  allowRequest.mockResolvedValue(true);
  mockQuery.mockReset().mockResolvedValue([]);
});

describe('CORS preflight', () => {
  test('answers OPTIONS without touching auth or the database', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-drafts.example/drafts', {
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
  test('rejects an unverified request before any draft is read or written', async () => {
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const response = await worker.fetch(request('/drafts'), env, ctx);
    expect(response.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('routing', () => {
  test('GET /drafts lists', async () => {
    const response = await worker.fetch(request('/drafts'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drafts: [] });
  });

  test("GET /drafts/:id 404s when the row is not the caller's", async () => {
    const response = await worker.fetch(request(`/drafts/${DRAFT_ID}`), env, ctx);
    expect(response.status).toBe(404);
  });

  test('an unknown path is not found', async () => {
    const response = await worker.fetch(request('/nope'), env, ctx);
    expect(response.status).toBe(404);
  });

  test('PATCH without an id is not allowed', async () => {
    const response = await worker.fetch(
      request('/drafts', autosave({ to: 'a@b.com', text: 'Hi' })),
      env,
      ctx,
    );
    expect(response.status).toBe(405);
  });

  test('DELETE without an id is refused rather than deleting every draft', async () => {
    const response = await worker.fetch(request('/drafts', { method: 'DELETE' }), env, ctx);
    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('autosave rate limit', () => {
  test('throttles a runaway client without reading its body', async () => {
    allowRequest.mockResolvedValue(false);
    const response = await worker.fetch(
      request(`/drafts/${DRAFT_ID}`, autosave({ to: 'a@b.com', text: 'Hi' })),
      env,
      ctx,
    );
    expect(response.status).toBe(429);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('reads are never throttled — opening the Drafts view must always work', async () => {
    allowRequest.mockResolvedValue(false);
    const response = await worker.fetch(request('/drafts'), env, ctx);
    expect(response.status).toBe(200);
    expect(allowRequest).not.toHaveBeenCalled();
  });
});
