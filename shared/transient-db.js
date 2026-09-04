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
