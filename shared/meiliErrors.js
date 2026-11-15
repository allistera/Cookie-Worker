/**
 * Only transport failures and proxy gateway responses are retryable. Ordinary
 * Meilisearch verdicts and malformed successful responses must still fail.
 *
 * @param {unknown} err
 */
export function isTransientMeiliError(err) {
  const error = /** @type {any} */ (err);
  if (error?.name === 'MeilisearchRequestError') return true;
  const status = error?.response?.status;
  // Cloudflare's plain-text gateway responses arrive this way too: since
  // meilisearch 0.63 a body that is not JSON still becomes an API error that
  // carries the HTTP status (0.62 threw a SyntaxError and lost it, COOKIE-WEB-1Q).
  return (
    typeof status === 'number' &&
    ((status >= 502 && status <= 504) || (status >= 520 && status <= 530))
  );
}
