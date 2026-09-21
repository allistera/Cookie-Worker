import { retryWithBackoff } from './retry.js';

/**
 * Whether a database error is worth one more try: the connection never came
 * up, timed out, or the socket to Hyperdrive dropped under a query (the
 * runtime's "Network connection lost", seen on cookie-web-messages reads as
 * Sentry COOKIE-WEB-M and COOKIE-WEB-R). Anything else — a bad query, a
 * constraint, a refused login — is permanent and must not be retried.
 *
 * @param {unknown} err
 */
export function isTransientDbError(err) {
  const code = /** @type {{code?: unknown}} */ (err)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === 'CONNECT_TIMEOUT' ||
    code === 'CONNECTION_CLOSED' ||
    code === '08006' ||
    code === '08001' ||
    /Failed to connect to database|CONNECT_TIMEOUT|timed? ?out|Network connection lost/i.test(
      message,
    )
  );
}

/**
 * Runs `task` against a client of its own, giving a transient connection
 * failure another go on a fresh client. A dropped socket poisons the client
 * it happened on, so every attempt creates one and ends it before the next.
 * Only idempotent work belongs here: a retry re-runs the whole task.
 *
 * @template T
 * @param {() => import('postgres').Sql} createClient
 * @param {(sql: import('postgres').Sql, attempt: number) => Promise<T>} task
 * @param {{attempts?: number, baseDelayMs?: number}} [options]
 * @returns {Promise<T>}
 */
export function retryWithFreshClient(
  createClient,
  task,
  { attempts = 3, baseDelayMs = 1000 } = {},
) {
  return retryWithBackoff(
    async (attempt) => {
      const sql = createClient();
      try {
        return await task(sql, attempt);
      } finally {
        await sql.end({ timeout: 2 }).catch(() => undefined);
      }
    },
    { attempts, baseDelayMs, isRetryable: isTransientDbError },
  );
}
