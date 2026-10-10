import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GoogleReauthRequired,
  beginAuthorization,
  completeAuthorization,
  consumeAuthorizationState,
  decryptToken,
  disconnect,
  encryptToken,
  getAccessToken,
  isGoogleConfigured,
  loadConnection,
  loadConnectionIfAvailable,
} from '../src/googleAuth.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-9999-9999-999999999999';
// 32 zero bytes, base64 — a valid (if unimaginative) AES-256 key for tests.
const KEY = btoa(String.fromCharCode(...new Uint8Array(32)));
const env = {
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_TOKEN_ENCRYPTION_KEY: KEY,
};

/** @param {unknown} body @param {number} [status] */
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** @param {string} email */
function idTokenWith(email) {
  const payload = btoa(JSON.stringify({ email, sub: '123' }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

/** @param {Partial<import('../src/googleAuth.js').GoogleConnection>} [overrides] */
async function connection(overrides = {}) {
  return {
    userId: USER_ID,
    email: 'person@example.com',
    refreshTokenEncrypted: await encryptToken('refresh-1', KEY),
    accessTokenEncrypted: null,
    accessTokenExpiresAt: null,
    selectedCalendars: [],
    needsReauth: false,
    ...overrides,
  };
}

describe('isGoogleConfigured', () => {
  it('needs the client id, client secret and encryption key together', () => {
    expect(isGoogleConfigured(env)).toBe(true);
    expect(isGoogleConfigured({ ...env, GOOGLE_CLIENT_SECRET: '' })).toBe(false);
    expect(isGoogleConfigured({})).toBe(false);
  });
});

describe('token encryption', () => {
  it('round-trips and never reuses an IV', async () => {
    const first = await encryptToken('1//refresh', KEY);
    const second = await encryptToken('1//refresh', KEY);
    expect(first).not.toBe(second);
    expect(first.startsWith('v1:')).toBe(true);
    expect(first).not.toContain('refresh');
    expect(await decryptToken(first, KEY)).toBe('1//refresh');
    expect(await decryptToken(second, KEY)).toBe('1//refresh');
  });

  it('rejects a tampered ciphertext and an unknown format', async () => {
    const stored = await encryptToken('secret', KEY);
    const [version, iv, ciphertext] = stored.split(':');
    const flipped = ciphertext.startsWith('A')
      ? `B${ciphertext.slice(1)}`
      : `A${ciphertext.slice(1)}`;
    await expect(decryptToken(`${version}:${iv}:${flipped}`, KEY)).rejects.toThrow();
    await expect(decryptToken('plain-text', KEY)).rejects.toThrow('Unrecognized token ciphertext');
  });

  it('refuses a key that is not 32 bytes', async () => {
    await expect(encryptToken('secret', btoa('short'))).rejects.toThrow('32 bytes');
  });
});

describe('beginAuthorization', () => {
  it('stores a single-use state for the user and builds the consent URL', async () => {
    const sql = createMockSql([[], []]);
    const url = new URL(
      await beginAuthorization(
        sql,
        USER_ID,
        {
          redirectUri: 'https://calendar-api.example/google-calendar/callback',
          returnTo: 'https://mail.example/settings/calendar',
        },
        env,
      ),
    );

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(env.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://calendar-api.example/google-calendar/callback',
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('auth/calendar.events');
    expect(url.searchParams.get('scope')).toContain('auth/calendar.calendarlist.readonly');
    const state = url.searchParams.get('state');
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    expect(sql.calls[0].text).toContain('DELETE FROM google_calendar_oauth_states');
    expect(sql.calls[1].text).toContain('INSERT INTO google_calendar_oauth_states');
    expect(sql.calls[1].values.slice(0, 4)).toEqual([
      state,
      USER_ID,
      'https://calendar-api.example/google-calendar/callback',
      'https://mail.example/settings/calendar',
    ]);
  });
});

describe('consumeAuthorizationState', () => {
  it('deletes and returns a live state', async () => {
    const sql = createMockSql([
      [
        {
          userId: USER_ID,
          redirectUri: 'https://api/cb',
          returnTo: 'https://app/settings/calendar',
          expired: false,
        },
      ],
    ]);
    expect(await consumeAuthorizationState(sql, 'state-1')).toEqual({
      userId: USER_ID,
      redirectUri: 'https://api/cb',
      returnTo: 'https://app/settings/calendar',
    });
    expect(sql.calls[0].text).toContain('DELETE FROM google_calendar_oauth_states');
  });

  it('answers null for an expired, unknown or oversized state', async () => {
    expect(
      await consumeAuthorizationState(
        createMockSql([[{ userId: USER_ID, redirectUri: 'x', returnTo: 'y', expired: true }]]),
        'old',
      ),
    ).toBeNull();
    expect(await consumeAuthorizationState(createMockSql([[]]), 'unknown')).toBeNull();
    const sql = createMockSql();
    expect(await consumeAuthorizationState(sql, 'x'.repeat(200))).toBeNull();
    expect(sql.calls).toHaveLength(0);
  });
});

describe('completeAuthorization', () => {
  it('exchanges the code and stores both tokens encrypted with the account email', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3599,
        id_token: idTokenWith('person@example.com'),
      }),
    );
    const sql = createMockSql([[]]);

    const result = await completeAuthorization(
      sql,
      USER_ID,
      { code: 'auth-code', redirectUri: 'https://api/cb' },
      env,
      fetchImpl,
    );

    expect(result).toEqual({ email: 'person@example.com' });
    const [url, init] = /** @type {any[][]} */ (fetchImpl.mock.calls)[0];
    expect(url).toBe(GOOGLE_TOKEN_URL);
    const params = new URLSearchParams(String(init.body));
    expect(params.get('code')).toBe('auth-code');
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('redirect_uri')).toBe('https://api/cb');
    expect(params.get('client_secret')).toBe('client-secret');

    const insert = sql.calls[0];
    expect(insert.text).toContain('INSERT INTO google_calendar_connections');
    expect(insert.text).toContain('ON CONFLICT (user_id) DO UPDATE');
    const [userId, email, refreshEncrypted, accessEncrypted] = insert.values;
    expect(userId).toBe(USER_ID);
    expect(email).toBe('person@example.com');
    expect(refreshEncrypted).not.toContain('refresh-1');
    expect(await decryptToken(refreshEncrypted, KEY)).toBe('refresh-1');
    expect(await decryptToken(accessEncrypted, KEY)).toBe('access-1');
  });

  it('fails when Google rejects the code or withholds a refresh token', async () => {
    await expect(
      completeAuthorization(
        createMockSql(),
        USER_ID,
        { code: 'bad', redirectUri: 'https://api/cb' },
        env,
        vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400)),
      ),
    ).rejects.toThrow('invalid_grant');
    await expect(
      completeAuthorization(
        createMockSql(),
        USER_ID,
        { code: 'ok', redirectUri: 'https://api/cb' },
        env,
        vi.fn(async () => jsonResponse({ access_token: 'a', expires_in: 10 })),
      ),
    ).rejects.toThrow('refresh token');
  });
});

describe('loadConnection', () => {
  it('maps the row and treats a missing table as not connected', async () => {
    const sql = createMockSql([
      [
        {
          userId: USER_ID,
          email: 'p@example.com',
          refreshTokenEncrypted: 'v1:a:b',
          accessTokenEncrypted: null,
          accessTokenExpiresAt: '2026-10-10T10:00:00.000Z',
          selectedCalendars: [
            { id: 'primary', name: 'Me', color: '#111111', primary: true, readOnly: false },
          ],
          needsReauth: null,
        },
      ],
    ]);
    const loaded = await loadConnection(sql, USER_ID);
    expect(loaded?.accessTokenExpiresAt).toBeInstanceOf(Date);
    expect(loaded?.needsReauth).toBe(false);
    expect(loaded?.selectedCalendars).toHaveLength(1);
    expect(await loadConnection(createMockSql([[]]), USER_ID)).toBeNull();

    const missing = vi.fn(() =>
      Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' })),
    );
    expect(await loadConnectionIfAvailable(/** @type {any} */ (missing), USER_ID)).toBeNull();
    const other = vi.fn(() => Promise.reject(new Error('boom')));
    await expect(loadConnectionIfAvailable(/** @type {any} */ (other), USER_ID)).rejects.toThrow(
      'boom',
    );
  });
});

describe('getAccessToken', () => {
  let fetchImpl;
  beforeEach(() => {
    fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'access-2', expires_in: 3600 }));
  });

  it('uses the cached token while it is still comfortably valid', async () => {
    const now = Date.parse('2026-10-10T10:00:00Z');
    const current = await connection({
      accessTokenEncrypted: await encryptToken('access-1', KEY),
      accessTokenExpiresAt: new Date(now + 5 * 60_000),
    });
    const sql = createMockSql();
    expect(await getAccessToken(sql, current, env, { fetchImpl, now: () => now })).toBe('access-1');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sql.calls).toHaveLength(0);
  });

  it('refreshes an expiring token, stores the new one and updates the connection in place', async () => {
    const now = Date.parse('2026-10-10T10:00:00Z');
    const current = await connection({
      accessTokenEncrypted: await encryptToken('access-1', KEY),
      accessTokenExpiresAt: new Date(now + 30_000),
    });
    const sql = createMockSql([[]]);

    expect(await getAccessToken(sql, current, env, { fetchImpl, now: () => now })).toBe('access-2');

    const params = new URLSearchParams(
      String(/** @type {any[][]} */ (fetchImpl.mock.calls)[0][1].body),
    );
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('refresh-1');
    expect(sql.calls[0].text).toContain('SET access_token_encrypted =');
    expect(await decryptToken(sql.calls[0].values[0], KEY)).toBe('access-2');
    expect(current.accessTokenExpiresAt?.getTime()).toBe(now + 3600_000);
    expect(await decryptToken(/** @type {string} */ (current.accessTokenEncrypted), KEY)).toBe(
      'access-2',
    );
  });

  it('forces a refresh when asked, even with a fresh cached token', async () => {
    const now = Date.now();
    const current = await connection({
      accessTokenEncrypted: await encryptToken('access-1', KEY),
      accessTokenExpiresAt: new Date(now + 3600_000),
    });
    expect(
      await getAccessToken(createMockSql([[]]), current, env, { force: true, fetchImpl }),
    ).toBe('access-2');
  });

  it('marks the connection for re-authorization when Google revoked the grant', async () => {
    fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    const current = await connection();
    const sql = createMockSql([[]]);
    await expect(getAccessToken(sql, current, env, { fetchImpl })).rejects.toBeInstanceOf(
      GoogleReauthRequired,
    );
    expect(sql.calls[0].text).toContain('SET needs_reauth = true');
    expect(current.needsReauth).toBe(true);
  });

  it('reports any other refresh failure as a plain error', async () => {
    fetchImpl = vi.fn(async () => jsonResponse({ error: 'temporarily_unavailable' }, 503));
    await expect(
      getAccessToken(createMockSql(), await connection(), env, { fetchImpl }),
    ).rejects.toThrow('temporarily_unavailable');
  });
});

describe('disconnect', () => {
  it('revokes the refresh token with Google and deletes the row', async () => {
    const stored = await connection();
    const sql = createMockSql([[{ ...stored, selectedCalendars: [] }], []]);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));

    expect(await disconnect(sql, USER_ID, env, fetchImpl)).toBe(true);

    expect(/** @type {any[][]} */ (fetchImpl.mock.calls)[0][0]).toBe(GOOGLE_REVOKE_URL);
    expect(
      new URLSearchParams(String(/** @type {any[][]} */ (fetchImpl.mock.calls)[0][1].body)).get(
        'token',
      ),
    ).toBe('refresh-1');
    expect(sql.calls[1].text).toContain('DELETE FROM google_calendar_connections');
  });

  it('still deletes the row when revocation fails, and is a no-op without a connection', async () => {
    const stored = await connection();
    const sql = createMockSql([[stored], []]);
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(await disconnect(sql, USER_ID, env, fetchImpl)).toBe(true);
    expect(sql.calls[1].text).toContain('DELETE FROM google_calendar_connections');

    const none = createMockSql([[]]);
    expect(await disconnect(none, USER_ID, env, fetchImpl)).toBe(false);
    expect(none.calls).toHaveLength(1);
  });
});
