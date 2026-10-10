// Google Calendar sign-in for the Calendar app: the OAuth authorization-code
// flow, the encrypted per-user token store, and access-token refresh.
//
// The browser never sees a Google token. Settings asks this Worker for an
// authorization URL, the browser follows it to Google, and Google sends the
// person back to this Worker's /google-calendar/callback, which exchanges the
// code and stores the refresh token encrypted (AES-256-GCM under the
// GOOGLE_TOKEN_ENCRYPTION_KEY secret) before redirecting back to Settings.
// The callback is a top-level navigation, so it cannot carry an Auth0 bearer
// token: the single-use `state` row — bound to the signed-in user when the
// flow started — is what ties the code to a Cookie account.
//
// Landing the callback on the Worker rather than on the SPA is deliberate:
// auth0-spa-js treats any `code` + `state` pair on the app's own URL as its
// own login callback and tries to redeem it against Auth0.

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

export const CALLBACK_PATH = '/google-calendar/callback';
const STATE_TTL_MS = 10 * 60 * 1000;
// Refresh a little before Google's own expiry so a request that starts with a
// valid token does not watch it lapse mid-flight.
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;
const TOKEN_TIMEOUT_MS = 10_000;

/**
 * @typedef {{
 *   GOOGLE_CLIENT_ID?: string,
 *   GOOGLE_CLIENT_SECRET?: string,
 *   GOOGLE_TOKEN_ENCRYPTION_KEY?: string,
 * }} GoogleEnv
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   color: string,
 *   primary: boolean,
 *   readOnly: boolean,
 * }} SelectedGoogleCalendar
 */

/**
 * @typedef {{
 *   userId: string,
 *   email: string | null,
 *   refreshTokenEncrypted: string,
 *   accessTokenEncrypted: string | null,
 *   accessTokenExpiresAt: Date | null,
 *   selectedCalendars: SelectedGoogleCalendar[],
 *   needsReauth: boolean,
 * }} GoogleConnection
 */

/** @param {GoogleEnv} env */
export function isGoogleConfigured(env) {
  return Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_TOKEN_ENCRYPTION_KEY,
  );
}

// Thrown when Google says the stored refresh token is no longer good
// (revoked in the Google account, password change, consent withdrawn). The
// connection row is kept so Settings can show "reconnect" with the account's
// email rather than silently dropping the person's calendar selection.
export class GoogleReauthRequired extends Error {
  constructor() {
    super('Google Calendar needs to be reconnected');
    this.name = 'GoogleReauthRequired';
  }
}

// ---------------------------------------------------------------------------
// Token encryption

/** @param {string} base64 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @param {Uint8Array} bytes */
function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** @param {Uint8Array} bytes */
function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** @type {Map<string, Promise<CryptoKey>>} */
const importedKeys = new Map();

/** @param {string} encodedKey Base64 of exactly 32 random bytes. */
function importKey(encodedKey) {
  let imported = importedKeys.get(encodedKey);
  if (!imported) {
    const bytes = base64ToBytes(encodedKey);
    if (bytes.length !== 32) {
      throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
    }
    imported = crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    importedKeys.clear();
    importedKeys.set(encodedKey, imported);
  }
  return imported;
}

/**
 * @param {string} plaintext
 * @param {string} encodedKey
 * @returns {Promise<string>} `v1:<iv>:<ciphertext>`, both base64.
 */
export async function encryptToken(plaintext, encodedKey) {
  const key = await importKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

/**
 * @param {string} stored
 * @param {string} encodedKey
 */
export async function decryptToken(stored, encodedKey) {
  const [version, iv, ciphertext] = String(stored).split(':');
  if (version !== 'v1' || !iv || !ciphertext) throw new Error('Unrecognized token ciphertext');
  const key = await importKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Authorization flow

/**
 * Starts a sign-in: records a single-use state bound to this user and returns
 * the Google URL the browser should navigate to.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{redirectUri: string, returnTo: string}} target
 * @param {GoogleEnv} env
 */
export async function beginAuthorization(sql, userId, { redirectUri, returnTo }, env) {
  const state = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  // Expired states are cleared opportunistically: nothing else ever reads
  // them, and a row per abandoned attempt is all that would otherwise pile up.
  await sql`DELETE FROM google_calendar_oauth_states WHERE expires_at < now()`;
  await sql`
    INSERT INTO google_calendar_oauth_states (state, user_id, redirect_uri, return_to, expires_at)
    SELECT ${state}, ${userId}, ${redirectUri}, ${returnTo}, ${expiresAt}
    WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId})
  `;

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', /** @type {string} */ (env.GOOGLE_CLIENT_ID));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('state', state);
  // offline + consent: a refresh token is only issued on a consenting
  // authorization, and re-connecting an account that already consented once
  // would otherwise come back with an access token alone.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}

/**
 * Redeems and deletes a state. Returns null when it is unknown or expired.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} state
 * @returns {Promise<{userId: string, redirectUri: string, returnTo: string} | null>}
 */
export async function consumeAuthorizationState(sql, state) {
  if (!state || state.length > 128) return null;
  const [row] = await sql`
    DELETE FROM google_calendar_oauth_states
    WHERE state = ${state}
    RETURNING user_id AS "userId", redirect_uri AS "redirectUri", return_to AS "returnTo",
              expires_at < now() AS expired
  `;
  if (!row || row.expired) return null;
  return { userId: row.userId, redirectUri: row.redirectUri, returnTo: row.returnTo };
}

/**
 * @param {Record<string, string>} params
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{ok: boolean, status: number, body: any}>}
 */
async function postTokenRequest(params, fetchImpl) {
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

/** @param {string | undefined} idToken */
function emailFromIdToken(idToken) {
  // Straight from Google's token endpoint over TLS, so the signature is not
  // re-verified here; the claim is display-only (which account is linked).
  const payload = String(idToken ?? '').split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    const email = JSON.parse(json)?.email;
    return typeof email === 'string' && email.length <= 320 ? email : null;
  } catch {
    return null;
  }
}

/**
 * Exchanges an authorization code and stores the connection. An existing
 * connection for the user is replaced: re-connecting the same Google account
 * (after `needs_reauth`, say) keeps the calendar selection, while a different
 * account starts with none, since the old ids belong to the old account.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{code: string, redirectUri: string}} grant
 * @param {GoogleEnv} env
 * @param {typeof fetch} [fetchImpl]
 */
export async function completeAuthorization(
  sql,
  userId,
  { code, redirectUri },
  env,
  fetchImpl = fetch,
) {
  const { ok, body } = await postTokenRequest(
    {
      code,
      client_id: /** @type {string} */ (env.GOOGLE_CLIENT_ID),
      client_secret: /** @type {string} */ (env.GOOGLE_CLIENT_SECRET),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    },
    fetchImpl,
  );
  if (!ok || typeof body.access_token !== 'string') {
    throw new Error(`Google token exchange failed: ${body.error ?? 'unknown error'}`);
  }
  if (typeof body.refresh_token !== 'string') {
    throw new Error('Google did not return a refresh token');
  }

  const key = /** @type {string} */ (env.GOOGLE_TOKEN_ENCRYPTION_KEY);
  const email = emailFromIdToken(body.id_token);
  const [refreshTokenEncrypted, accessTokenEncrypted] = await Promise.all([
    encryptToken(body.refresh_token, key),
    encryptToken(body.access_token, key),
  ]);
  const expiresAt = new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000);
  await sql`
    INSERT INTO google_calendar_connections
      (user_id, google_email, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
    SELECT ${userId}, ${email}, ${refreshTokenEncrypted}, ${accessTokenEncrypted}, ${expiresAt}
    WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId})
    ON CONFLICT (user_id) DO UPDATE SET
      google_email = EXCLUDED.google_email,
      refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
      access_token_encrypted = EXCLUDED.access_token_encrypted,
      access_token_expires_at = EXCLUDED.access_token_expires_at,
      selected_calendars = CASE
        WHEN google_calendar_connections.google_email IS NOT DISTINCT FROM EXCLUDED.google_email
          THEN google_calendar_connections.selected_calendars
        ELSE '[]'::jsonb
      END,
      needs_reauth = false,
      updated_at = now()
  `;
  return { email };
}

// ---------------------------------------------------------------------------
// Connection store

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @returns {Promise<GoogleConnection | null>}
 */
export async function loadConnection(sql, userId) {
  const [row] = await sql`
    SELECT user_id AS "userId", google_email AS email,
           refresh_token_encrypted AS "refreshTokenEncrypted",
           access_token_encrypted AS "accessTokenEncrypted",
           access_token_expires_at AS "accessTokenExpiresAt",
           selected_calendars AS "selectedCalendars",
           needs_reauth AS "needsReauth"
    FROM google_calendar_connections
    WHERE user_id = ${userId}
  `;
  if (!row) return null;
  return {
    userId: String(row.userId),
    email: row.email ?? null,
    refreshTokenEncrypted: String(row.refreshTokenEncrypted),
    accessTokenEncrypted: row.accessTokenEncrypted ?? null,
    accessTokenExpiresAt: row.accessTokenExpiresAt ? new Date(row.accessTokenExpiresAt) : null,
    selectedCalendars: Array.isArray(row.selectedCalendars) ? row.selectedCalendars : [],
    needsReauth: row.needsReauth === true,
  };
}

/**
 * The connection row is only ever read when the calendars table is already
 * available; a missing table (migration 0091 not applied yet) reads as "not
 * connected" so the rest of the Calendar app keeps working through rollout.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function loadConnectionIfAvailable(sql, userId) {
  try {
    return await loadConnection(sql, userId);
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code === '42P01') return null;
    throw error;
  }
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {SelectedGoogleCalendar[]} calendars
 */
export async function saveSelectedCalendars(sql, userId, calendars) {
  await sql`
    UPDATE google_calendar_connections
    SET selected_calendars = ${sql.json(/** @type {any} */ (calendars))}, updated_at = now()
    WHERE user_id = ${userId}
  `;
}

/**
 * Removes the connection, telling Google to revoke the grant first. Revocation
 * is best-effort: the row goes either way, and a token Google already
 * invalidated revokes as a 400 that is not worth surfacing.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {GoogleEnv} env
 * @param {typeof fetch} [fetchImpl]
 */
export async function disconnect(sql, userId, env, fetchImpl = fetch) {
  const connection = await loadConnection(sql, userId);
  if (!connection) return false;
  try {
    const refreshToken = await decryptToken(
      connection.refreshTokenEncrypted,
      /** @type {string} */ (env.GOOGLE_TOKEN_ENCRYPTION_KEY),
    );
    await fetchImpl(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'google_revoke_failed',
        message: /** @type {Error} */ (error)?.message,
      }),
    );
  }
  await sql`DELETE FROM google_calendar_connections WHERE user_id = ${userId}`;
  return true;
}

/**
 * A usable access token for the connection, refreshing through Google when
 * the cached one has (nearly) expired. `force` skips the cache after a 401.
 *
 * @param {import('postgres').Sql} sql
 * @param {GoogleConnection} connection
 * @param {GoogleEnv} env
 * @param {{force?: boolean, fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export async function getAccessToken(sql, connection, env, options = {}) {
  const key = /** @type {string} */ (env.GOOGLE_TOKEN_ENCRYPTION_KEY);
  const now = options.now ?? Date.now;
  if (
    !options.force &&
    connection.accessTokenEncrypted &&
    connection.accessTokenExpiresAt &&
    connection.accessTokenExpiresAt.getTime() - ACCESS_TOKEN_SKEW_MS > now()
  ) {
    return decryptToken(connection.accessTokenEncrypted, key);
  }

  const refreshToken = await decryptToken(connection.refreshTokenEncrypted, key);
  const { ok, body } = await postTokenRequest(
    {
      refresh_token: refreshToken,
      client_id: /** @type {string} */ (env.GOOGLE_CLIENT_ID),
      client_secret: /** @type {string} */ (env.GOOGLE_CLIENT_SECRET),
      grant_type: 'refresh_token',
    },
    options.fetchImpl ?? fetch,
  );
  if (!ok || typeof body.access_token !== 'string') {
    if (body.error === 'invalid_grant') {
      await sql`
        UPDATE google_calendar_connections
        SET needs_reauth = true, access_token_encrypted = NULL, access_token_expires_at = NULL,
            updated_at = now()
        WHERE user_id = ${connection.userId}
      `;
      connection.needsReauth = true;
      throw new GoogleReauthRequired();
    }
    throw new Error(`Google token refresh failed: ${body.error ?? 'unknown error'}`);
  }

  const expiresAt = new Date(now() + Number(body.expires_in ?? 3600) * 1000);
  const accessTokenEncrypted = await encryptToken(body.access_token, key);
  await sql`
    UPDATE google_calendar_connections
    SET access_token_encrypted = ${accessTokenEncrypted}, access_token_expires_at = ${expiresAt},
        needs_reauth = false, updated_at = now()
    WHERE user_id = ${connection.userId}
  `;
  connection.accessTokenEncrypted = accessTokenEncrypted;
  connection.accessTokenExpiresAt = expiresAt;
  connection.needsReauth = false;
  return body.access_token;
}
