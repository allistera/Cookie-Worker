import { beforeEach, describe, expect, test, vi } from 'vitest';

// Routing/CORS/auth wiring is what this file tests — the business logic
// (calendarEvents.js/calendars.js/calendarSync.js) has its own unit tests, so
// the database is stubbed here.
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

const allowRequest = vi.fn();
vi.mock('../../../shared/rate-limit.js', () => ({
  allowRequest: (...args) => allowRequest(...args),
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
  OPENAI_API_KEY: 'test-key',
});
const ctx = /** @type {any} */ ({ waitUntil: (promise) => promise });

/** @param {string} path @param {RequestInit} [init] */
function request(path, init = {}) {
  return new Request(`https://cookie-web-calendar.example${path}`, {
    ...init,
    headers: { Origin: PRODUCTION, Authorization: 'Bearer token', ...init.headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyAccessToken.mockResolvedValue({ userId: 'user-1' });
  allowRequest.mockResolvedValue(true);
  mockQuery.mockReset().mockResolvedValue([]);
});

describe('CORS preflight', () => {
  test('answers OPTIONS from an allowed origin without touching auth or the database', async () => {
    const response = await worker.fetch(
      new Request('https://cookie-web-calendar.example/calendar-events', {
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
  test('availability is authenticated before reading calendars or feeds', async () => {
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const response = await worker.fetch(
      request('/calendar-availability', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(response.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  test('rejects a request that fails verification, without dispatching to a handler', async () => {
    verifyAccessToken.mockRejectedValue(new Error('invalid token'));
    const response = await worker.fetch(request('/calendar-events'), env, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PRODUCTION);
  });
});

describe('GET /calendar-events', () => {
  test('lists the (empty) expanded window', async () => {
    const response = await worker.fetch(request('/calendar-events'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [], truncated: false });
  });

  test('rejects a mismatched range pair with 400', async () => {
    const response = await worker.fetch(request('/calendar-events?from=2026-08-01'), env, ctx);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('YYYY-MM-DD');
  });
});

describe('GET /calendars', () => {
  test('lists calendars (seeding defaults on an empty account)', async () => {
    mockQuery
      .mockResolvedValueOnce([]) // fetchCalendars: none
      .mockResolvedValueOnce([]) // seed insert
      .mockResolvedValueOnce([{ id: 'id-1', name: 'Work', color: '#4f7c6b' }]);
    const response = await worker.fetch(request('/calendars'), env, ctx);
    expect(response.status).toBe(200);
    expect((await response.json()).calendars).toHaveLength(1);
  });

  test('answers 503 while the calendars table is still being created', async () => {
    verifyAccessToken.mockResolvedValue({ userId: 'user-1' });
    mockQuery.mockRejectedValue(Object.assign(new Error('missing table'), { code: '42P01' }));
    const response = await worker.fetch(
      request('/calendars', {
        method: 'PATCH',
        body: JSON.stringify({ id: '11111111-1111-1111-1111-111111111111', name: 'Renamed' }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('upgraded');
  });

  test('PATCH with defaultCalendarId saves the default instead of renaming', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    mockQuery.mockResolvedValueOnce([{ id }]).mockResolvedValueOnce([]);
    const response = await worker.fetch(
      request('/calendars', { method: 'PATCH', body: JSON.stringify({ defaultCalendarId: id }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ defaultCalendarId: id });
    expect(mockQuery.mock.calls[1][0].join('?')).toContain('UPDATE users');
  });
});

describe('POST routing', () => {
  test('availability has a POST-only validated read route', async () => {
    const get = await worker.fetch(request('/calendar-availability'), env, ctx);
    expect(get.status).toBe(405);
    expect(get.headers.get('Allow')).toBe('POST');
    const post = await worker.fetch(
      request('/calendar-availability', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(post.status).toBe(400);
    expect(allowRequest).not.toHaveBeenCalled();
  });
  test('action=interpret validates before claiming quota', async () => {
    const response = await worker.fetch(
      request('/calendar-events', {
        method: 'POST',
        body: JSON.stringify({ action: 'interpret', text: '   ', timeZone: 'Europe/London' }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(allowRequest).not.toHaveBeenCalled();
  });

  test('a plain POST reaches createEvent validation', async () => {
    const response = await worker.fetch(
      request('/calendar-events', { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid event fields' });
  });

  test('POST /calendars with action=sync claims the calendar-sync quota first', async () => {
    allowRequest.mockResolvedValue(false);
    const response = await worker.fetch(
      request('/calendars', { method: 'POST', body: JSON.stringify({ action: 'sync', id: 'x' }) }),
      env,
      ctx,
    );
    expect(response.status).toBe(429);
    expect(allowRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'calendar-sync', {
      limit: 5,
      windowMs: 60_000,
    });
  });

  test('a plain calendar create does not claim the sync quota', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 'id-1', name: 'Trips', color: '#3b82f6' }]);
    const response = await worker.fetch(
      request('/calendars', {
        method: 'POST',
        body: JSON.stringify({ name: 'Trips', color: '#3b82f6' }),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(201);
    expect(allowRequest).not.toHaveBeenCalled();
  });
});

describe('routing and cleanup', () => {
  test('an unknown path returns 404', async () => {
    const response = await worker.fetch(request('/unknown'), env, ctx);
    expect(response.status).toBe(404);
  });

  test('invalid JSON returns 400', async () => {
    const response = await worker.fetch(
      request('/calendar-events', { method: 'POST', body: '{not json' }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
  });

  test('closes the sql connection on a successful request', async () => {
    await worker.fetch(request('/calendar-events'), env, ctx);
    expect(sqlEnd).toHaveBeenCalledOnce();
  });
});

describe('/google-calendar', () => {
  const googleEnv = {
    ...env,
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    GOOGLE_TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32))),
  };

  test('GET reports an unconfigured deployment without touching the database', async () => {
    const response = await worker.fetch(request('/google-calendar'), env, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, connected: false });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('GET reports not connected when the account has no row', async () => {
    const response = await worker.fetch(request('/google-calendar'), googleEnv, ctx);
    expect(await response.json()).toEqual({ configured: true, connected: false });
  });

  test('POST action=authorize answers the Google consent URL for a Cookie return URL', async () => {
    const response = await worker.fetch(
      request('/google-calendar', {
        method: 'POST',
        body: JSON.stringify({
          action: 'authorize',
          returnTo: `${PRODUCTION}/settings/calendar`,
        }),
      }),
      googleEnv,
      ctx,
    );
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).url);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://cookie-web-calendar.example/google-calendar/callback',
    );
  });

  test('other POST actions are rejected and PATCH validates its ids', async () => {
    const other = await worker.fetch(
      request('/google-calendar', { method: 'POST', body: JSON.stringify({ action: 'x' }) }),
      googleEnv,
      ctx,
    );
    expect(other.status).toBe(400);
    const patch = await worker.fetch(
      request('/google-calendar', { method: 'PATCH', body: JSON.stringify({}) }),
      googleEnv,
      ctx,
    );
    expect(patch.status).toBe(400);
  });

  test('the callback skips bearer auth and answers plainly for an unknown state', async () => {
    const response = await worker.fetch(
      new Request(
        'https://cookie-web-calendar.example/google-calendar/callback?code=abc&state=unknown',
      ),
      googleEnv,
      ctx,
    );
    expect(response.status).toBe(400);
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledOnce();
    expect(sqlEnd).toHaveBeenCalledOnce();
  });

  test('a stored-calendar event cannot be moved onto a Google calendar', async () => {
    const response = await worker.fetch(
      request('/calendar-events', {
        method: 'PATCH',
        body: JSON.stringify({
          id: '11111111-1111-1111-1111-111111111111',
          title: 'Lunch',
          date: '2026-10-10',
          start: '12:00',
          duration: 30,
          calendar: 'google:person@example.com',
        }),
      }),
      googleEnv,
      ctx,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Google calendar');
  });

  test('a Google event id routes DELETE to Google, which needs a connection', async () => {
    const response = await worker.fetch(
      request('/calendar-events', {
        method: 'DELETE',
        body: JSON.stringify({ id: 'google:person@example.com:evt1' }),
      }),
      googleEnv,
      ctx,
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Calendar not found');
  });

  test('GET /calendar-events rejects an unknown time zone', async () => {
    const response = await worker.fetch(
      request('/calendar-events?from=2026-10-01&to=2026-10-31&timeZone=Mars/Olympus'),
      googleEnv,
      ctx,
    );
    expect(response.status).toBe(400);
  });
});
