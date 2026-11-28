import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing, CORS and auth wiring are what this file tests; the handlers have
// their own tests against a mock sql, so the database is stubbed here.
const mockQuery = vi.fn(
  /** @param {any[]} _args */ (..._args) => Promise.resolve(/** @type {any[]} */ ([])),
);
const sqlEnd = vi.fn(async () => undefined);
vi.mock('postgres', () => ({
  default: () => {
    /** @type {any} */
    const sql = (/** @type {any[]} */ ...args) => mockQuery(...args);
    sql.begin = async (/** @type {(sql: any) => unknown} */ callback) => callback(sql);
    sql.json = (/** @type {unknown} */ value) => value;
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
  tagTrigger: () => undefined,
}));

const worker = (await import('../src/worker.js')).default;

const PRODUCTION = 'https://mail.infinitywave.online';
const tasksCall = vi.fn(
  /** @param {any[]} _args */ async (..._args) => ({ status: 200, body: {} }),
);
const env = /** @type {any} */ ({
  HYPERDRIVE: { connectionString: 'postgres://stub' },
  AUTH0_DOMAIN: 'tenant.example.auth0.com',
  AUTH0_AUDIENCE: 'https://cookie-web/api',
  ALLOWED_ORIGIN: PRODUCTION,
  TASKS: { call: tasksCall },
});
const ID = '11111111-1111-4111-8111-111111111111';
const TRIGGER = {
  type: 'schedule',
  time: '00:00',
  days: ['mon'],
  timeZone: 'Europe/London',
};

/** @param {string} path @param {RequestInit & {json?: unknown}} [init] */
function request(path, { json, ...init } = {}) {
  return new Request(`https://cookie-web-automations.example${path}`, {
    ...init,
    body: json === undefined ? init.body : JSON.stringify(json),
    headers: {
      Origin: PRODUCTION,
      Authorization: 'Bearer token',
      ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
}

/** @param {Request} incoming */
function send(incoming) {
  /** @type {Promise<unknown>[]} */
  const pending = [];
  const ctx = /** @type {any} */ ({ waitUntil: (promise) => pending.push(promise) });
  return worker.fetch(incoming, env, ctx).then(async (response) => {
    await Promise.all(pending);
    return response;
  });
}

beforeEach(() => {
  verifyAccessToken.mockReset().mockResolvedValue({ userId: 'user-1' });
  mockQuery.mockReset().mockResolvedValue([]);
  tasksCall.mockClear();
  captureHandledException.mockClear();
});

describe('routing', () => {
  test('answers a CORS preflight without touching auth or the database', async () => {
    const response = await send(
      new Request('https://cookie-web-automations.example/automations', {
        method: 'OPTIONS',
        headers: { Origin: PRODUCTION, 'Access-Control-Request-Method': 'POST' },
      }),
    );

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('refuses a request without a valid token', async () => {
    verifyAccessToken.mockRejectedValue(new Error('bad token'));

    const response = await send(request('/automations'));

    expect(response.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('lists the caller’s automations with CORS headers', async () => {
    mockQuery.mockResolvedValueOnce([{ id: ID }]);

    const response = await send(request('/automations'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ automations: [{ id: ID }] });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
  });

  test('creates an automation from a JSON body', async () => {
    mockQuery.mockResolvedValueOnce([{ count: 0 }]).mockResolvedValueOnce([{ id: ID }]);

    const response = await send(
      request('/automations', {
        method: 'POST',
        json: { handler: 'reschedule_overdue', trigger: TRIGGER },
      }),
    );

    expect(response.status).toBe(201);
  });

  test('routes PATCH and DELETE to the caller’s automation', async () => {
    mockQuery
      .mockResolvedValueOnce([{ trigger: TRIGGER, enabled: true }])
      .mockResolvedValueOnce([{ id: ID, enabled: false }]);
    const patched = await send(
      request('/automations', { method: 'PATCH', json: { id: ID, enabled: false } }),
    );
    expect(await patched.json()).toEqual({ automation: { id: ID, enabled: false } });

    mockQuery.mockResolvedValueOnce([{ id: ID }]);
    const deleted = await send(request('/automations', { method: 'DELETE', json: { id: ID } }));
    expect(deleted.status).toBe(204);
  });

  test('runs an automation now through the tasks binding', async () => {
    mockQuery
      .mockResolvedValueOnce([
        {
          id: ID,
          name: 'Clean slate',
          userId: 'user-1',
          email: 'owner@example.com',
          handler: 'reschedule_overdue',
          trigger: TRIGGER,
        },
      ])
      .mockResolvedValueOnce([{ id: 'run-1', startedAt: '2026-11-28T15:00:00.000Z' }])
      .mockResolvedValueOnce([{ id: 'task-1', mirrored: false }]);

    const response = await send(request('/automations/run', { method: 'POST', json: { id: ID } }));

    expect((await response.json()).run).toMatchObject({
      status: 'succeeded',
      summary: 'Moved 1 overdue task to today.',
    });
    expect(tasksCall).toHaveBeenCalledWith(
      { userId: 'user-1', email: 'owner@example.com' },
      expect.objectContaining({ method: 'PATCH', path: '/task-items' }),
    );
  });

  test('lists the caller’s runs', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 'run-1' }]);

    const response = await send(request('/automation-runs'));

    expect(await response.json()).toEqual({ runs: [{ id: 'run-1' }] });
  });

  test.each([
    ['/automations', 'PUT', 'GET, POST, PATCH, DELETE'],
    ['/automations/run', 'GET', 'POST'],
    ['/automation-runs', 'POST', 'GET'],
  ])('answers 405 with the allowed methods for %s %s', async (path, method, allow) => {
    const response = await send(request(path, { method }));

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe(allow);
  });

  test('answers 404 for an unknown path', async () => {
    expect((await send(request('/automations/unknown'))).status).toBe(404);
  });

  test('refuses a body that is not a JSON object', async () => {
    const response = await send(request('/automations', { method: 'POST', json: [1, 2] }));
    expect(response.status).toBe(400);
  });

  test('reports a database failure and answers 500 without its detail', async () => {
    mockQuery.mockRejectedValue(new Error('connection lost: postgres://secret'));

    const response = await send(request('/automation-runs'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Request failed' });
    expect(captureHandledException).toHaveBeenCalledWith(
      'fetch',
      expect.any(Error),
      env,
      expect.objectContaining({ path: '/automation-runs' }),
    );
  });
});

describe('scheduled', () => {
  /** @returns {Promise<void>} */
  async function tick() {
    /** @type {Promise<unknown>[]} */
    const pending = [];
    const ctx = /** @type {any} */ ({ waitUntil: (promise) => pending.push(promise) });
    await worker.scheduled(
      /** @type {any} */ ({ scheduledTime: Date.parse('2026-11-30T00:00:00Z') }),
      env,
      ctx,
    );
    await Promise.all(pending);
  }

  test('runs what is due at the tick’s own time and closes its connection', async () => {
    mockQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: ID,
          userId: 'user-1',
          email: 'owner@example.com',
          handler: 'reschedule_overdue',
          trigger: TRIGGER,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'run-1' }])
      .mockResolvedValueOnce([{ id: 'task-1', mirrored: false }]);

    await tick();

    expect(tasksCall).toHaveBeenCalledTimes(1);
    expect(tasksCall.mock.calls[0][1]).toMatchObject({
      body: { id: 'task-1', dueDate: '2026-11-30' },
    });
    expect(sqlEnd).toHaveBeenCalled();
  });

  test('reports a tick that fails instead of throwing', async () => {
    mockQuery.mockRejectedValue(new Error('connection lost'));

    await expect(tick()).resolves.toBeUndefined();
    expect(captureHandledException).toHaveBeenCalledWith('scheduled', expect.any(Error), env);
  });
});
