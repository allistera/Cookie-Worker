import { AuthFailure, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { createSql, endSql } from '../../../shared/db.js';

export const METADATA_PATHS = [
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-protected-resource',
];

/** @param {{MCP_RESOURCE: string, AUTH0_DOMAIN: string}} env */
export function protectedResourceMetadata(env) {
  const issuer = `https://${String(env.AUTH0_DOMAIN).split(',')[0].trim()}/`;
  return {
    resource: env.MCP_RESOURCE,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'Cookie',
  };
}

/** @param {{MCP_RESOURCE: string}} env */
function metadataUrl(env) {
  const resource = new URL(env.MCP_RESOURCE);
  return `${resource.origin}${METADATA_PATHS[0]}`;
}

/**
 * Verifies the bearer token against this server's own audience and maps it
 * to the mailbox owner. Returns the identity, or the Response to send.
 *
 * @param {Request} request
 * @param {any} env
 * @param {ExecutionContext} ctx
 * @returns {Promise<{userId: string, email: string} | Response>}
 */
export async function authenticate(request, env, ctx) {
  const sql = createSql(env.HYPERDRIVE.connectionString);
  try {
    const { userId, email } = await verifyAccessToken(request, env, sql);
    return { userId, email };
  } catch (error) {
    const status = error instanceof AuthFailure ? error.status : 401;
    if (status === 503) return Response.json({ error: 'Authentication unavailable' }, { status });
    if (status === 403) return Response.json({ error: 'Forbidden' }, { status });
    return Response.json(
      { error: 'invalid_token' },
      {
        status: 401,
        headers: { 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl(env)}"` },
      },
    );
  } finally {
    ctx.waitUntil(endSql(sql));
  }
}
