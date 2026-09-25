import { retryWithBackoff } from './retry.js';

/**
 * Whether a database error is worth one more try: the connection never came
 * up or the socket to Hyperdrive dropped under a query (the runtime's
 * "Network connection lost", seen on cookie-web-messages reads as Sentry
 * COOKIE-WEB-M and COOKIE-WEB-R). Only dropped-connection signals count:
 * postgres.js's CONNECTION_CLOSED / CONNECTION_ENDED / CONNECT_TIMEOUT and
 * SQLSTATE class 08. A statement_timeout (57014) is the query itself being
 * too slow and would just time out again, and a generic "timed out" from
 * fetch or Blob is not a database connection at all. Anything else — a bad
 * query, a constraint, a refused login — is permanent and must not be
 * retried.
 *
 * @param {unknown} err
 */
export function isTransientDbError(err) {
  const code = /** @type {{code?: unknown}} */ (err)?.code;
  if (code === '57014') return false;
  const message = err instanceof Error ? err.message : String(err);
  // A wrapper such as AuthFailure('Mailbox lookup failed', {cause}) keeps the
  // dropped socket underneath it; the retry decision needs to see through.
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause !== undefined && cause !== err && isTransientDbError(cause)) return true;
  return (
    code === 'CONNECT_TIMEOUT' ||
    code === 'CONNECTION_CLOSED' ||
    code === 'CONNECTION_ENDED' ||
    (typeof code === 'string' && /^08[0-9A-Z]{3}$/.test(code)) ||
    /Failed to connect to database|CONNECT_TIMEOUT|CONNECTION_CLOSED|CONNECTION_ENDED|Network connection lost/i.test(
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
