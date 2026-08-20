// Ported from Cookie-Web's api/_lib/auth.js: jose's JWKS/JWT verification is
// pure Web Crypto, so it runs unchanged on Workers. The only differences are
// Workers-shaped: env vars instead of process.env, request.headers.get(...)
// instead of Node's lowercased header object, and the caller passes in an
// already-connected sql client instead of this module lazily creating one
// (a Worker invocation creates its own short-lived Hyperdrive connection;
// there is no long-lived process to cache a singleton pool in).

import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwksByIssuer = new Map();

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
    throw new Error('AUTH0_DOMAIN and AUTH0_AUDIENCE must be set');
  }

  const [scheme, token] = (request.headers.get('Authorization') ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new Error('Missing bearer token');
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
  const { payload } = await verifyJwt(token, keySet, {
    issuer,
    audience,
    algorithms: ['RS256'],
    clockTolerance: 5,
  });

  const subject = String(payload.sub ?? '').trim();
  if (!subject) {
    throw new Error('Access token has no subject');
  }

  const [user] = await sql`
    SELECT id, lower(email) AS email
    FROM users
    WHERE auth0_sub = ${subject}
    LIMIT 1
  `;
  if (!user?.id || !user?.email) {
    throw new Error('Access token subject is not provisioned');
  }

  return { ...payload, sub: subject, userId: user.id, email: user.email };
}
