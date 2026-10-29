import postgres from 'postgres';
import { authFailureResponse, verifyAccessToken } from './auth-jwt.js';
import { connectionAttributes, instrumentSql } from './db-tracing.js';
import { retryWithBackoff } from './retry.js';
import { setSpanAttributes } from './tracing.js';
import { isTransientDbError } from './transient-db.js';

/**
 * A client whose queries show up as spans in a traced invocation
 * (shared/db-tracing.js); outside one it is the plain driver client.
 *
 * @param {string} databaseUrl
 */
export function createSql(databaseUrl) {
  /** @type {import('postgres').Sql} */
  let sql;
  try {
    // No ssl option: Hyperdrive terminates TLS to the origin database itself;
    // asking the driver for TLS makes every connect fail and retry until the
    // invocation dies with "Too many subrequests".
    sql = postgres(databaseUrl, {
      prepare: false,
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  } catch {
    // The driver's parse error can quote the URL, credentials included.
    throw new Error('database connection string is not valid');
  }
  return instrumentSql(sql, connectionAttributes(databaseUrl));
}

/**
 * Best-effort client teardown for cron and email handlers, which own their
 * clients outright: never throws, so it is safe in finally blocks and waitUntil.
 *
 * @param {import('postgres').Sql | null | undefined} sql
 */
export function endSql(sql) {
  if (!sql) return Promise.resolve();
  return sql.end({ timeout: 2 }).catch(() => undefined);
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
          setSpanAttributes({ 'cookie.request.retried': true });
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
