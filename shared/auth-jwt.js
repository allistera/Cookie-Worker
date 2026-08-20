// Ported from Cookie-Web's api/_lib/auth.js: jose's JWKS/JWT verification is
// pure Web Crypto, so it runs unchanged on Workers. The only differences are
// Workers-shaped: env vars instead of process.env, request.headers.get(...)
// instead of Node's lowercased header object, and the caller passes in an
// already-connected sql client instead of this module lazily creating one
// (a Worker invocation creates its own short-lived Hyperdrive connection;
// there is no long-lived process to cache a singleton pool in).
//
// Shared because every Worker that Cookie-Web's SPA calls directly (rather
// than server-to-server over a bearer token) needs the exact same check.

import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwksByIssuer = new Map();

export class AuthFailure extends Error {
  /**
   * @param {string} message
   * @param {401 | 403 | 503} status
   */
  constructor(message, status) {
    super(message);
    this.name = 'AuthFailure';
    this.status = status;
  }
}

/** @param {unknown} error */
export function authFailureResponse(error) {
  const status = error instanceof AuthFailure ? error.status : 401;
  const message =
    status === 503 ? 'Authentication unavailable' : status === 403 ? 'Forbidden' : 'Unauthorized';
  return Response.json({ error: message }, { status });
}

/**
 * Validates the request's Bearer token against the Auth0 tenant's JWKS.
 * Resolves the verified issuer + subject to a provisioned local user. Email
 * claims are deliberately ignored: they are mutable profile data and must not
 * decide which mailbox an access token can read.
 *
 * @param {Request} request
 * @param {{AUTH0_DOMAIN?: string, AUTH0_AUDIENCE?: string}} env
 * @param {import('postgres').Sql} sql
 * @param {{jwks?: ReturnType<typeof createRemoteJWKSet>, jwtVerify?: typeof jwtVerify}} [overrides]
 */
export async function verifyAccessToken(request, env, sql, overrides = {}) {
  const domain = env.AUTH0_DOMAIN;
  const audience = env.AUTH0_AUDIENCE;
  if (!domain || !audience) {
    throw new AuthFailure('AUTH0_DOMAIN and AUTH0_AUDIENCE must be set', 503);
  }

  const [scheme, token] = (request.headers.get('Authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AuthFailure('Missing bearer token', 401);
  }

  const issuer = `https://${domain}/`;
  let keySet = overrides.jwks;
  if (!keySet) {
    keySet = jwksByIssuer.get(issuer);
    if (!keySet) {
      keySet = createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
      jwksByIssuer.set(issuer, keySet);
    }
  }

  const verifyJwt = overrides.jwtVerify ?? jwtVerify;
  let payload;
  try {
    ({ payload } = await verifyJwt(token, keySet, {
      issuer,
      audience,
      algorithms: ['RS256'],
      clockTolerance: 5,
    }));
  } catch {
    throw new AuthFailure('Invalid access token', 401);
  }

  const subject = String(payload.sub ?? '').trim();
  if (!subject) {
    throw new AuthFailure('Access token has no subject', 401);
  }

  let user;
  try {
    [user] = await sql`
      SELECT id, lower(email) AS email
      FROM users
      WHERE auth0_sub = ${subject}
      LIMIT 1
    `;
  } catch {
    throw new AuthFailure('Mailbox lookup failed', 503);
  }
  if (!user?.id || !user?.email) {
    throw new AuthFailure('Access token subject is not provisioned', 403);
  }

  return { ...payload, sub: subject, userId: user.id, email: user.email };
}
