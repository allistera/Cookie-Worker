import postgres from 'postgres';
import { authFailureResponse, verifyAccessToken } from './auth-jwt.js';
import { retryWithBackoff } from './retry.js';
import { isTransientDbError } from './transient-db.js';

/** @param {string} databaseUrl */
export function createSql(databaseUrl) {
  // No ssl option: Hyperdrive terminates TLS to the origin database itself;
  // asking the driver for TLS makes every connect fail (see data-enricher).
  return postgres(databaseUrl, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

/**
 * Authenticates a user request and runs `handle` on a request-scoped client,
 * which is closed (via waitUntil) once the request settles.
 *
 * The socket to Hyperdrive drops under a query now and then (Sentry
 * COOKIE-WEB-M, -R, -17 ("Network connection lost"), -Z and -1A). When
 * `retryable` is set, a dropped connection gets one more go on a fresh client,
 * caller lookup included, so the user sees neither a 500 nor a spurious 401.
 * Only idempotent work may set it: a retry re-runs `handle` from the top.
 * Anything else a caller lookup throws, or a dropped lookup with no attempt
 * left, becomes the usual auth failure response.
 *
 * @param {Request} request
 * @param {{HYPERDRIVE: {connectionString: string}, AUTH0_DOMAIN?: string, AUTH0_AUDIENCE?: string}} env
 * @param {ExecutionContext} ctx
 * @param {{retryable: boolean}} options
 * @param {(sql: import('postgres').Sql, userId: string, attempt: number) => Promise<Response>} handle
 * @returns {Promise<Response>}
 */
export async function withUserSql(request, env, ctx, { retryable }, handle) {
  const attempts = retryable ? 2 : 1;
  let sql = createSql(env.HYPERDRIVE.connectionString);
  try {
    return await retryWithBackoff(
      async (attempt) => {
        if (attempt > 1) {
          const dropped = sql;
          ctx.waitUntil(dropped.end({ timeout: 2 }).catch(() => undefined));
          sql = createSql(env.HYPERDRIVE.connectionString);
          console.log(
            JSON.stringify({
              event: 'request_retried',
              path: new URL(request.url).pathname,
              method: request.method,
            }),
          );
        }
        let userId;
        try {
          ({ userId } = await verifyAccessToken(request, env, sql));
        } catch (error) {
          // Throw only when another attempt follows; otherwise a dropped
          // mailbox lookup stays the usual 503 "Authentication unavailable".
          if (attempt < attempts && isTransientDbError(error)) throw error;
          return authFailureResponse(error);
        }
        return handle(sql, userId, attempt);
      },
      {
        attempts,
        baseDelayMs: 100,
        isRetryable: isTransientDbError,
      },
    );
  } finally {
    const current = sql;
    ctx.waitUntil(current.end({ timeout: 2 }).catch(() => undefined));
  }
}
