import { AuthFailure, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { createSql, endSql } from '../../../shared/db.js';

export const METADATA_PATHS = [
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-protected-resource',
];

// cookie:read lists, reads and searches; cookie:write adds every tool that
// changes something, sending mail included. An Auth0 application granted only
// cookie:read is therefore a read-only connection.
const READ_SCOPE = 'cookie:read';
const WRITE_SCOPE = 'cookie:write';
const SCOPES = `${READ_SCOPE} ${WRITE_SCOPE}`;

/** @param {{MCP_RESOURCE: string, AUTH0_DOMAIN: string}} env */
export function protectedResourceMetadata(env) {
  const issuer = `https://${String(env.AUTH0_DOMAIN).split(',')[0].trim()}/`;
  return {
    resource: env.MCP_RESOURCE,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [READ_SCOPE, WRITE_SCOPE],
    resource_name: 'Cookie',
  };
}

/** @param {{MCP_RESOURCE: string}} env */
function metadataUrl(env) {
  const resource = new URL(env.MCP_RESOURCE);
  return `${resource.origin}${METADATA_PATHS[0]}`;
}

/**
 * Only the OAuth scope is delegated to the client. Auth0's permissions
 * claim can also contain account rights the client never requested.
 * @param {{scope?: unknown}} claims
 */
function grantedScopes(claims) {
  return new Set(typeof claims.scope === 'string' ? claims.scope.split(' ') : []);
}

/**
 * @param {number} status
 * @param {string} error
 * @param {string} challenge
 */
function challengeResponse(status, error, challenge) {
  return Response.json({ error }, { status, headers: { 'WWW-Authenticate': challenge } });
}

/**
 * Verifies the bearer token against this server's own audience and maps it
 * to the mailbox owner. Returns the caller, or the Response to send.
 *
 * @param {Request} request
 * @param {any} env
 * @param {ExecutionContext} ctx
 * @returns {Promise<{userId: string, email: string, canWrite: boolean} | Response>}
 */
export async function authenticate(request, env, ctx) {
  const metadata = `resource_metadata="${metadataUrl(env)}"`;
  const sql = createSql(env.HYPERDRIVE.connectionString);
  let claims;
  try {
    claims = await verifyAccessToken(request, env, sql);
  } catch (error) {
    const status = error instanceof AuthFailure ? error.status : 401;
    if (status === 503) return Response.json({ error: 'Authentication unavailable' }, { status });
    if (status === 403) return Response.json({ error: 'Forbidden' }, { status });
    // error="invalid_token" only when a token was presented and refused, so a
    // client can tell "refresh" from "start signing in" (RFC 6750 section 3.1).
    const presented = Boolean(request.headers.get('Authorization'));
    return challengeResponse(
      401,
      'invalid_token',
      `Bearer ${presented ? 'error="invalid_token", ' : ''}scope="${SCOPES}", ${metadata}`,
    );
  } finally {
    ctx.waitUntil(endSql(sql));
  }

  const scopes = grantedScopes(claims);
  const canWrite = scopes.has(WRITE_SCOPE);
  if (!canWrite && !scopes.has(READ_SCOPE)) {
    return challengeResponse(
      403,
      'insufficient_scope',
      `Bearer error="insufficient_scope", scope="${SCOPES}", ${metadata}`,
    );
  }
  return { userId: claims.userId, email: claims.email, canWrite };
}
