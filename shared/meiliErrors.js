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
  if (typeof status === 'number') {
    return (status >= 502 && status <= 504) || (status >= 520 && status <= 530);
  }
  // meilisearch 0.62 parses the body before checking response.ok. Cloudflare's
  // plain-text gateway response therefore loses its HTTP status (COOKIE-WEB-1Q).
  // Recognize only that specific response, never arbitrary JSON syntax errors.
  return (
    error instanceof SyntaxError &&
    /["']error code: (?:50[234]|52\d|530)(?:\s|\\n|["'])/u.test(error.message)
  );
}
