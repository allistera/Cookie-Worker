import { describe, expect, it, vi } from 'vitest';
import { encryptToken } from '../../../shared/token-crypto.js';
import {
  deleteTodoistSettings,
  getTodoistSettings,
  postTodoistSync,
  publicSettings,
  putTodoistSettings,
} from '../src/todoistSettings.js';
import { createMockSql } from './helpers.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));
const env = /** @type {any} */ ({ TODOIST_TOKEN_ENCRYPTION_KEY: KEY });

/** @param {unknown} body @param {number} [status] */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** @param {Partial<Record<string, unknown>>} [overrides] */
async function connectionRow(overrides = {}) {
  return {
    userId: USER_ID,
    apiTokenEncrypted: await encryptToken('todoist-token', KEY),
    tokenHint: 'oken',
    email: 'person@example.com',
    timeZone: 'Europe/London',
    enabled: true,
    lastSyncedAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    lastSyncSummary: null,
    ...overrides,
  };
}

describe('GET /tasks/todoist', () => {
  it('reports not connected, and whether the deployment is configured', async () => {
    const response = await getTodoistSettings(createMockSql([[]]), USER_ID, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      todoist: {
        configured: true,
        connected: false,
        enabled: false,
        email: null,
        tokenHint: '',
        timeZone: null,
        lastSyncedAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
        lastSyncSummary: null,
      },
    });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('describes a connection without its token', async () => {
    const row = await connectionRow({
      lastSyncedAt: '2026-10-15T08:00:00.000Z',
      lastSyncStatus: 'ok',
      lastSyncSummary: { projects: 2 },
    });
    const response = await getTodoistSettings(createMockSql([[row]]), USER_ID, env);
    const { todoist } = await response.json();
    expect(todoist).toMatchObject({
      connected: true,
      enabled: true,
      email: 'person@example.com',
      tokenHint: 'oken',
      lastSyncedAt: '2026-10-15T08:00:00.000Z',
      lastSyncStatus: 'ok',
      lastSyncSummary: { projects: 2 },
    });
    expect(JSON.stringify(todoist)).not.toContain('v1:');
  });

  it('reads a missing table as not connected', async () => {
    const sql = createMockSql();
    sql.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('no table'), { code: '42P01' })),
    );
    const response = await getTodoistSettings(sql, USER_ID, env);
    expect((await response.json()).todoist.connected).toBe(false);
  });

  it('says so when the deployment has no encryption key', () => {
    expect(publicSettings({}, null).configured).toBe(false);
  });
});

describe('PUT /tasks/todoist', () => {
  it('answers 501 without the encryption key', async () => {
    const response = await putTodoistSettings(
      createMockSql(),
      USER_ID,
      { token: 'x' },
      /** @type {any} */ ({}),
    );
    expect(response.status).toBe(501);
  });

  it('refuses an empty body, a non-boolean flag and a malformed token before calling Todoist', async () => {
    const fetchImpl = vi.fn();
    expect(
      (await putTodoistSettings(createMockSql(), USER_ID, {}, env, { fetchImpl })).status,
    ).toBe(400);
    expect(
      (await putTodoistSettings(createMockSql(), USER_ID, { enabled: 'yes' }, env, { fetchImpl }))
        .status,
    ).toBe(400);
    expect(
      (
        await putTodoistSettings(createMockSql(), USER_ID, { token: 'has space' }, env, {
          fetchImpl,
        })
      ).status,
    ).toBe(400);
    expect(
      (await putTodoistSettings(createMockSql(), USER_ID, { token: '' }, env, { fetchImpl }))
        .status,
    ).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a token Todoist rejects, and reports an outage as 502, storing nothing', async () => {
    const sql = createMockSql();
    const rejected = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const response = await putTodoistSettings(sql, USER_ID, { token: 'nope' }, env, {
      fetchImpl: /** @type {any} */ (rejected),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Todoist rejected that token');

    const down = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const outage = await putTodoistSettings(sql, USER_ID, { token: 'nope' }, env, {
      fetchImpl: /** @type {any} */ (down),
    });
    expect(outage.status).toBe(502);
    expect(sql.calls).toHaveLength(0);
  });

  it('checks the token with Todoist, then stores it encrypted with the account details', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ email: 'person@example.com', tz_info: { timezone: 'Europe/Paris' } }),
      );
    const sql = createMockSql([[await connectionRow({ timeZone: 'Europe/Paris' })]]);

    const response = await putTodoistSettings(sql, USER_ID, { token: ' abcdef123456 ' }, env, {
      fetchImpl: /** @type {any} */ (fetchImpl),
    });

    expect(response.status).toBe(200);
    expect(new URL(String(fetchImpl.mock.calls[0][0])).pathname).toBe('/api/v1/user');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer abcdef123456');
    const { text, values } = sql.calls[0];
    expect(text).toContain('INSERT INTO todoist_connections');
    expect(values[0]).toBe(USER_ID);
    expect(String(values[1]).startsWith('v1:')).toBe(true);
    expect(values[1]).not.toContain('abcdef123456');
    expect(values[2]).toBe('3456');
    expect(values[3]).toBe('person@example.com');
    expect(values[4]).toBe('Europe/Paris');
    expect(values[5]).toBe(true); // enabled defaults on for a new connection
    expect(values[7]).toBe(false); // hasEnabled: keep the existing flag on a replace
    expect((await response.json()).todoist).toMatchObject({
      connected: true,
      timeZone: 'Europe/Paris',
    });
  });

  it('flips only the schedule flag when no token is sent, and 404s without a connection', async () => {
    const row = await connectionRow({ enabled: false });
    const sql = createMockSql([[row]]);
    const response = await putTodoistSettings(sql, USER_ID, { enabled: false }, env);
    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toContain('UPDATE todoist_connections SET enabled = ?');
    expect(sql.calls[0].values).toEqual([false, USER_ID]);
    expect((await response.json()).todoist.enabled).toBe(false);

    const missing = await putTodoistSettings(createMockSql([[]]), USER_ID, { enabled: true }, env);
    expect(missing.status).toBe(404);
  });
});

describe('DELETE /tasks/todoist', () => {
  it('forgets the connection and 404s when there is none', async () => {
    const sql = createMockSql([[{ user_id: USER_ID }]]);
    expect((await deleteTodoistSettings(sql, USER_ID)).status).toBe(200);
    expect(sql.calls[0].text).toContain('DELETE FROM todoist_connections');
    expect((await deleteTodoistSettings(createMockSql([[]]), USER_ID)).status).toBe(404);
  });
});

describe('POST /tasks/todoist/sync', () => {
  it('answers 501 unconfigured, 429 over quota and 404 unconnected', async () => {
    expect((await postTodoistSync(createMockSql(), USER_ID, /** @type {any} */ ({}))).status).toBe(
      501,
    );
    expect(
      (await postTodoistSync(createMockSql([[{ allowed: false }]]), USER_ID, env)).status,
    ).toBe(429);
    expect(
      (await postTodoistSync(createMockSql([[{ allowed: true }], []]), USER_ID, env)).status,
    ).toBe(404);
  });

  it('answers 409 and records the failure when the stored token cannot be decrypted', async () => {
    const row = await connectionRow({ apiTokenEncrypted: 'v1:AAAA:BBBB' });
    const sql = createMockSql([[{ allowed: true }], [row], []]);
    const response = await postTodoistSync(sql, USER_ID, env);
    expect(response.status).toBe(409);
    expect(sql.calls[2].text).toContain('UPDATE todoist_connections');
    expect(sql.calls[2].values).toContain('failed');
  });

  it('runs the sync with the decrypted token and answers with the refreshed settings', async () => {
    const fetchImpl = vi.fn(async (/** @type {any} */ url, /** @type {any} */ init) => {
      expect(init.headers.Authorization).toBe('Bearer todoist-token');
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/by_completion_date'))
        return jsonResponse({ items: [], next_cursor: null });
      return jsonResponse({ results: [], next_cursor: null });
    });
    const before = await connectionRow();
    const after = await connectionRow({ lastSyncStatus: 'ok', lastSyncSummary: { tasks: 0 } });
    const sql = createMockSql([
      [{ allowed: true }],
      [before],
      [], // vanished projects deleted
      [], // unlinked
      [], // existing mirrors
      [], // recordSyncResult
      [after],
    ]);

    const response = await postTodoistSync(sql, USER_ID, env, {
      fetchImpl: /** @type {any} */ (fetchImpl),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).todoist).toMatchObject({
      lastSyncStatus: 'ok',
      lastSyncSummary: { tasks: 0 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('maps a rejected token to 409 and a Todoist outage to 502', async () => {
    const row = await connectionRow();
    const rejected = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const unauthorized = await postTodoistSync(
      createMockSql([[{ allowed: true }], [row], []]),
      USER_ID,
      env,
      {
        fetchImpl: /** @type {any} */ (rejected),
      },
    );
    expect(unauthorized.status).toBe(409);

    const down = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    const outage = await postTodoistSync(
      createMockSql([[{ allowed: true }], [row], []]),
      USER_ID,
      env,
      {
        fetchImpl: /** @type {any} */ (down),
      },
    );
    expect(outage.status).toBe(502);
    expect((await outage.json()).error).toBe('Todoist responded 503.');
  });
});
