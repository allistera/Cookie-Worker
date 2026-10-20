// One-time send permits for the MCP agent. The model cannot mint these:
// POST /send/confirmation refuses the internal service-binding identity, so
// only a browser session signed in as the mailbox owner can create one.
// The same permit can be retried for one requestId until it expires. A
// second email needs a new permit.

import { internalCaller } from '../../../shared/internal-identity.js';
import { allowRequest } from '../../../shared/rate-limit.js';

const TOKEN_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const CONFIRMATION_RATE_LIMIT = { limit: 10, windowMs: 60_000 };

/** @param {string} token */
export async function hashSendConfirmation(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function createSendConfirmation(sql, userId) {
  if (internalCaller()) {
    return Response.json(
      { error: 'Send confirmations are created in Cookie, not by an agent' },
      { status: 403 },
    );
  }
  if (!(await allowRequest(sql, userId, 'mcp-send-confirmation', CONFIRMATION_RATE_LIMIT))) {
    return Response.json(
      { error: 'Too many send confirmations. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }
  const token = newToken();
  const tokenHash = await hashSendConfirmation(token);
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString();
  try {
    await sql`
      INSERT INTO mcp_send_confirmations (token_hash, user_id, expires_at)
      VALUES (${tokenHash}, ${userId}, ${expiresAt}::timestamptz)
    `;
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code === '42P01') {
      return Response.json(
        { error: 'Send confirmations are being upgraded. Try again shortly.' },
        { status: 503 },
      );
    }
    throw error;
  }
  return Response.json(
    { confirmation: token, expiresAt },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Claims a browser-minted permit for this agent send. Retries of the same
 * requestId succeed until the permit expires; any other requestId does not.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {unknown} token
 * @param {string} requestId
 * @returns {Promise<{ok: true} | {ok: false, status: number, error: string, code: string}>}
 */
export async function consumeSendConfirmation(sql, userId, token, requestId) {
  const confirmation = String(token ?? '');
  if (!TOKEN_RE.test(confirmation) || !REQUEST_ID_RE.test(requestId)) {
    return {
      ok: false,
      status: 403,
      error: 'A send confirmation from Cookie is required',
      code: 'SEND_CONFIRMATION_REQUIRED',
    };
  }
  const tokenHash = await hashSendConfirmation(confirmation);
  try {
    const [row] = await sql`
      UPDATE mcp_send_confirmations
      SET used_at = COALESCE(used_at, now()),
          request_id = COALESCE(request_id, ${requestId})
      WHERE token_hash = ${tokenHash}
        AND user_id = ${userId}
        AND expires_at > now()
        AND (request_id IS NULL OR request_id = ${requestId})
      RETURNING token_hash
    `;
    if (!row) {
      return {
        ok: false,
        status: 403,
        error: 'A send confirmation from Cookie is required',
        code: 'SEND_CONFIRMATION_REQUIRED',
      };
    }
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code === '42P01') {
      return {
        ok: false,
        status: 503,
        error: 'Send confirmations are being upgraded. Try again shortly.',
        code: 'SEND_CONFIRMATION_UNAVAILABLE',
      };
    }
    throw error;
  }
  return { ok: true };
}
