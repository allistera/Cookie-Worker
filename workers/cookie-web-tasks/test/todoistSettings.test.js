import { describe, expect, it, vi } from 'vitest';
import { encryptToken } from '../../../shared/token-crypto.js';
import {
  deleteTodoistSettings,
  getTodoistSettings,
  isDifferentAccount,
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
    todoistUserId: 'todoist-user-1',
    email: 'person@example.com',
    timeZone: 'Europe/London',
    enabled: true,
    syncProjects: true,
    syncTasks: true,
    lastSyncedAt: null,
    tasksSyncedAt: null,
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
        syncProjects: true,
        syncTasks: true,
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
      syncProjects: true,
      syncTasks: true,
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
    const badFlag = await putTodoistSettings(createMockSql(), USER_ID, { syncTasks: 1 }, env, {
      fetchImpl,
    });
    expect(badFlag.status).toBe(400);
    expect((await badFlag.json()).error).toBe('syncTasks must be true or false');
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
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'todoist-user-1',
        email: 'person@example.com',
        tz_info: { timezone: 'Europe/Paris' },
      }),
    );
    // No connection yet, then the saved row.
    const sql = createMockSql([[], [await connectionRow({ timeZone: 'Europe/Paris' })]]);

    const response = await putTodoistSettings(sql, USER_ID, { token: ' abcdef123456 ' }, env, {
      fetchImpl: /** @type {any} */ (fetchImpl),
    });

    expect(response.status).toBe(200);
    expect(new URL(String(fetchImpl.mock.calls[0][0])).pathname).toBe('/api/v1/user');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer abcdef123456');
    expect(sql.calls[0].text).toContain('FROM todoist_connections');
    const { text, values } = sql.calls[1];
    expect(text).toContain('INSERT INTO todoist_connections');
    expect(values[0]).toBe(USER_ID);
    expect(String(values[1]).startsWith('v1:')).toBe(true);
    expect(values[1]).not.toContain('abcdef123456');
    expect(values[2]).toBe('3456');
    expect(values[3]).toBe('todoist-user-1');
    expect(values[4]).toBe('person@example.com');
    expect(values[5]).toBe('Europe/Paris');
    // The three switches default on for a new connection...
    expect(values.slice(6, 9)).toEqual([true, true, true]);
    // ...and, not having been sent, keep their stored values on a replace.
    expect(values.slice(10, 13)).toEqual([null, null, null]);
    expect(text).toContain(
      'enabled             = COALESCE(?::boolean, todoist_connections.enabled)',
    );
    expect(values[13]).toBe(false); // not an account switch
    expect(sql.calls.some((call) => call.text.includes('SET todoist_id = NULL'))).toBe(false);
    expect((await response.json()).todoist).toMatchObject({
      connected: true,
      timeZone: 'Europe/Paris',
    });
  });

  it("unlinks the previous account's mirrors when the new token belongs to another account", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ id: 'todoist-user-2', email: 'other@example.com', tz_info: {} }),
      );
    const existing = await connectionRow();
    const saved = await connectionRow({
      todoistUserId: 'todoist-user-2',
      email: 'other@example.com',
    });
    const sql = createMockSql([[existing], [], [], [saved]]);

    const response = await putTodoistSettings(sql, USER_ID, { token: 'newtoken99' }, env, {
      fetchImpl: /** @type {any} */ (fetchImpl),
    });

    expect(response.status).toBe(200);
    expect(sql.controlCalls[0].text).toContain('pg_advisory_xact_lock');
    expect(sql.calls[1].text).toContain('UPDATE task_items SET todoist_id = NULL');
    expect(sql.calls[2].text).toContain('UPDATE task_projects SET todoist_id = NULL');
    expect(sql.calls[3].text).toContain('INSERT INTO todoist_connections');
    // switchesAccount resets the last-success stamp and the completion cursor.
    expect(sql.calls[3].text).toContain('tasks_synced_at     = CASE WHEN ?::boolean THEN NULL');
    expect(sql.calls[3].values.slice(13, 16)).toEqual([true, true, true]);
    expect((await response.json()).todoist.email).toBe('other@example.com');
  });

  it('treats a renewed token for the same account as a plain replacement', async () => {
    const existing = await connectionRow();
    expect(isDifferentAccount(existing, { id: 'todoist-user-1', email: 'new@example.com' })).toBe(
      false,
    );
    expect(
      isDifferentAccount(existing, { id: 'todoist-user-2', email: 'person@example.com' }),
    ).toBe(true);
    const noId = { ...existing, todoistUserId: null };
    expect(isDifferentAccount(noId, { id: null, email: 'Person@example.com' })).toBe(false);
    expect(isDifferentAccount(noId, { id: null, email: 'other@example.com' })).toBe(true);
    expect(isDifferentAccount({ ...noId, email: null }, { id: null, email: null })).toBe(false);
  });

  it('flips only the flags sent when no token is given, and 404s without a connection', async () => {
    const row = await connectionRow({ enabled: false });
    const sql = createMockSql([[row]]);
    const response = await putTodoistSettings(sql, USER_ID, { enabled: false }, env);
    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toContain('enabled       = COALESCE(?::boolean, enabled)');
    expect(sql.calls[0].text).toContain('sync_projects = COALESCE(?::boolean, sync_projects)');
    // Flags left out are sent as null, so COALESCE keeps the stored value.
    expect(sql.calls[0].values).toEqual([false, null, null, USER_ID]);
    expect((await response.json()).todoist.enabled).toBe(false);

    const switched = await connectionRow({ syncProjects: false });
    const both = createMockSql([[switched]]);
    const settings = await putTodoistSettings(
      both,
      USER_ID,
      { syncProjects: false, syncTasks: true },
      env,
    );
    expect(both.calls[0].values).toEqual([null, false, true, USER_ID]);
    expect((await settings.json()).todoist).toMatchObject({
      syncProjects: false,
      syncTasks: true,
    });

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

  it('reads only the projects from Todoist when tasks are switched off', async () => {
    const fetchImpl = vi.fn(async (/** @type {any} */ _url) =>
      jsonResponse({ results: [], next_cursor: null }),
    );
    const before = await connectionRow({ syncTasks: false });
    const after = await connectionRow({ syncTasks: false, lastSyncStatus: 'ok' });
    const sql = createMockSql([
      [{ allowed: true }],
      [before],
      [], // vanished projects deleted
      [], // unlinked
      [], // recordSyncResult
      [after],
    ]);

    const response = await postTodoistSync(sql, USER_ID, env, {
      fetchImpl: /** @type {any} */ (fetchImpl),
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetchImpl.mock.calls[0][0])).pathname).toBe('/api/v1/projects');
    expect(sql.calls.some((call) => call.text.includes('INSERT INTO task_items'))).toBe(false);
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
