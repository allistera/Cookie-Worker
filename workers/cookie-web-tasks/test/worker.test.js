import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth wiring is what this file tests — the business logic
// (tasks.js/documents.js/interests.js/etc.) already has its own unit tests
// against a mock sql, so the database, @vercel/blob, and fetch are stubbed
// here rather than exercised.
const mockQuery = vi.fn(
  /** @param {any[]} _args */ (..._args) => Promise.resolve(/** @type {any[]} */ ([])),
);
const sqlEnd = vi.fn(async () => undefined);
vi.mock('postgres', () => ({
  default: () => {
    /** @type {any} */
    const sql = (/** @type {any[]} */ ...args) => mockQuery(...args);
    sql.json = (/** @type {any} */ value) => ({ __json: value });
    sql.array = (/** @type {any} */ value) => ({ __array: value });
    sql.begin = async (/** @type {(sql: any) => unknown} */ callback) => callback(sql);
    sql.end = sqlEnd;
    return sql;
  },
}));

const put = vi.fn().mockResolvedValue({ url: 'https://blob.example/photo.png' });
vi.mock('@vercel/blob', () => ({ put: (/** @type {any[]} */ ...args) => put(...args) }));

const verifyAccessToken = vi.fn();
vi.mock('../../../shared/auth-jwt.js', () => ({
  verifyAccessToken: (/** @type {any[]} */ ...args) => verifyAccessToken(...args),
  authFailureResponse: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
}));
vi.mock('../src/rateLimit.js', () => ({ allowRequest: async () => true }));

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
  ENRICHER: { fetch: vi.fn(async () => ({ ok: true, status: 200 })) },
  ENRICHER_TRIGGER_TOKEN: 'trigger-secret',
  OWNER_EMAIL: 'owner@example.com',
});
const ctx = /** @type {any} */ ({
  waitUntil: (/** @type {Promise<unknown>} */ promise) => promise,
});

/** @param {string} path @param {RequestInit} [init] */
function request(path, init = {}) {
  return new Request(`https://cookie-web-tasks.example${path}`, {
    ...init,
    headers: { Origin: PRODUCTION, Authorization: 'Bearer token', ...init.headers },
  });
}

const TASK_ID = '11111111-1111-1111-1111-111111111111';
const DOC_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  verifyAccessToken.mockResolvedValue({ userId: 'user-1', email: 'owner@example.com' });
  mockQuery.mockReset().mockResolvedValue([]);
  put.mockResolvedValue({ url: 'https://blob.example/photo.png' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200 })),
  );
});

describe('CORS preflight', () => {
  test('answers OPTIONS from an allowed origin without touching auth or the database', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-tasks.example/tasks', {
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
    const response = await worker.fetch(request('/tasks'), env, ctx);
    expect(response.status).toBe(401);
  });
});

describe('routing — /tasks', () => {
  test('GET /tasks dispatches to getTasks', async () => {
    const response = await worker.fetch(request('/tasks'), env, ctx);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ tasks: [], digest: null, news: null });
  });

  test('POST /tasks dispatches to postTasks', async () => {
    const response = await worker.fetch(
      request('/tasks', {
        method: 'POST',
        body: JSON.stringify({ id: TASK_ID, action: 'complete' }),
      }),
      env,
      ctx,
    );
    // Empty mock result -> "task not found", proof the request reached postTasks.
    expect(response.status).toBe(404);
  });

  test('DELETE on /tasks returns 405', async () => {
    const response = await worker.fetch(request('/tasks', { method: 'DELETE' }), env, ctx);
    expect(response.status).toBe(405);
  });

  test('invalid JSON on POST /tasks returns 400 before reaching a handler', async () => {
    const response = await worker.fetch(
      request('/tasks', { method: 'POST', body: '{not json' }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
  });
});

describe('routing — /tasks/refresh', () => {
  test('POST /tasks/refresh dispatches to postRefresh', async () => {
    mockQuery.mockResolvedValueOnce([{ allowed: true }]);
    const response = await worker.fetch(request('/tasks/refresh', { method: 'POST' }), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('GET on /tasks/refresh returns 405', async () => {
    const response = await worker.fetch(request('/tasks/refresh'), env, ctx);
    expect(response.status).toBe(405);
  });

  // The enricher rebuilds the fixed OWNER_EMAIL mailbox's AI state, so a
  // provisioned non-owner must not be able to spend that owner's budget.
  test('POST /tasks/refresh from a non-owner account returns 403', async () => {
    verifyAccessToken.mockResolvedValue({ userId: 'user-2', email: 'guest@example.com' });
    const response = await worker.fetch(request('/tasks/refresh', { method: 'POST' }), env, ctx);
    expect(response.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('POST /tasks/refresh without OWNER_EMAIL configured returns 403', async () => {
    const response = await worker.fetch(
      request('/tasks/refresh', { method: 'POST' }),
      { ...env, OWNER_EMAIL: undefined },
      ctx,
    );
    expect(response.status).toBe(403);
  });
});

describe('routing — /tasks/interests', () => {
  test('GET /tasks/interests dispatches to getInterests', async () => {
    const response = await worker.fetch(request('/tasks/interests'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ interests: [] });
  });

  test('PUT /tasks/interests dispatches to putInterests', async () => {
    mockQuery.mockResolvedValueOnce([{ interests: ['Vue'] }]);
    const response = await worker.fetch(
      request('/tasks/interests', { method: 'PUT', body: JSON.stringify({ interests: ['Vue'] }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ interests: ['Vue'] });
  });

  test('POST on /tasks/interests returns 405', async () => {
    const response = await worker.fetch(request('/tasks/interests', { method: 'POST' }), env, ctx);
    expect(response.status).toBe(405);
  });
});

describe('routing — /tasks/daily-note-seed', () => {
  test('GET /tasks/daily-note-seed dispatches to getDailyNoteSeed', async () => {
    const response = await worker.fetch(request('/tasks/daily-note-seed'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ blocks: [] });
  });

  test('PUT /tasks/daily-note-seed dispatches to putDailyNoteSeed', async () => {
    mockQuery.mockResolvedValueOnce([{ blocks: [] }]);
    const response = await worker.fetch(
      request('/tasks/daily-note-seed', { method: 'PUT', body: JSON.stringify({ blocks: [] }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
  });
});

describe('routing — /tasks/image-upload', () => {
  test('POST /tasks/image-upload dispatches to postImageUpload with blob deps wired', async () => {
    const form = new FormData();
    form.set(
      'image',
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'photo.png', {
        type: 'image/png',
      }),
    );
    const response = await worker.fetch(
      request('/tasks/image-upload', { method: 'POST', body: form }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://blob.example/photo.png' });
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^documents\/.+\/[0-9a-f-]{36}\.png$/),
      expect.any(ArrayBuffer),
      expect.objectContaining({ token: 'blob-token' }),
    );
  });

  test('GET on /tasks/image-upload returns 405', async () => {
    const response = await worker.fetch(request('/tasks/image-upload'), env, ctx);
    expect(response.status).toBe(405);
  });
});

describe('routing — /documents', () => {
  test('GET /documents dispatches to getDocuments', async () => {
    const response = await worker.fetch(request('/documents'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ folders: [], documents: [] });
  });

  test('POST /documents dispatches to createDocument', async () => {
    const response = await worker.fetch(
      request('/documents', {
        method: 'POST',
        body: JSON.stringify({ kind: 'folder', title: 'Notes' }),
      }),
      env,
      ctx,
    );
    // No user row returned -> "user not found", proof the request reached createDocument.
    expect(response.status).toBe(404);
  });

  test('PATCH /documents dispatches to updateDocument', async () => {
    const response = await worker.fetch(
      request('/documents', {
        method: 'PATCH',
        body: JSON.stringify({ id: DOC_ID, starred: true }),
      }),
      env,
      ctx,
    );
    // No row returned -> "document not found", proof the request reached updateDocument.
    expect(response.status).toBe(404);
  });

  test('DELETE /documents dispatches to deleteDocument', async () => {
    const response = await worker.fetch(
      request('/documents', { method: 'DELETE', body: JSON.stringify({ id: DOC_ID }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(404);
  });

  test('invalid JSON on POST /documents returns 400 before reaching a handler', async () => {
    const response = await worker.fetch(
      request('/documents', { method: 'POST', body: '{not json' }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
  });

  test('a nested /documents path returns 404', async () => {
    const response = await worker.fetch(request('/documents/extra'), env, ctx);
    expect(response.status).toBe(404);
  });
});

describe('routing — unknown paths', () => {
  test('a completely unknown top-level path returns 404', async () => {
    const response = await worker.fetch(request('/unknown'), env, ctx);
    expect(response.status).toBe(404);
  });

  test('an unknown /tasks sub-path returns 404', async () => {
    const response = await worker.fetch(request('/tasks/unknown'), env, ctx);
    expect(response.status).toBe(404);
  });
});

describe('cleanup and error reporting', () => {
  test('closes the sql connection on a successful request', async () => {
    await worker.fetch(request('/tasks/interests'), env, ctx);
    expect(sqlEnd).toHaveBeenCalledOnce();
  });

  test('closes the sql connection and reports a 500 when a handler throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection reset'));
    const response = await worker.fetch(request('/tasks/interests'), env, ctx);
    expect(response.status).toBe(500);
    expect(captureHandledException).toHaveBeenCalledOnce();
    expect(sqlEnd).toHaveBeenCalledOnce();
  });
});

describe('POST /task-items/reorder', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  test('dispatches to the reorder handler', async () => {
    // The handler reads the rows' positions, then writes them back.
    mockQuery
      .mockResolvedValueOnce([{ id: ID, position: 1 }])
      .mockResolvedValueOnce([{ id: ID, position: 1 }]);
    const response = await worker.fetch(
      request('/task-items/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [ID] }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).items).toEqual([{ id: ID, position: 1 }]);
  });

  test('refuses other methods', async () => {
    const response = await worker.fetch(request('/task-items/reorder'), env, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});

describe('POST /task-items/interpret', () => {
  test('dispatches to the natural-language task interpreter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              output_text: JSON.stringify({
                content: 'Call plumber',
                description: '',
                dueDate: '2026-09-11',
                dueTime: '15:00',
                recurrence: '',
              }),
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    const response = await worker.fetch(
      request('/task-items/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Call plumber Friday 3pm p1 @home', timeZone: 'UTC' }),
      }),
      { ...env, OPENAI_API_KEY: 'test-key' },
      ctx,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      draft: { content: 'Call plumber', priority: 1, labels: ['home'] },
    });
  });

  test('refuses other methods', async () => {
    const response = await worker.fetch(request('/task-items/interpret'), env, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});
