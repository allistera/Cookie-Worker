// Retries a Meilisearch call on transient failures — 5xx responses and
// network errors — with exponential backoff. A 4xx means the request itself
// was wrong (bad filter, bad payload); retrying it just burns time. This
// exists because the old embedding workflow died on a single transient 520
// and lost a week of repair — see repair-search-drift.js.

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableMeiliError(error) {
  const err = /** @type {any} */ (error);
  // Thrown by the meilisearch client when fetch itself fails (DNS, TCP,
  // timeout, etc.) — always worth a retry.
  if (err?.name === 'MeilisearchRequestError') return true;
  // Thrown for any non-2xx response. err.response is the raw fetch Response;
  // only 5xx is transient, a 4xx is a bug in what we sent.
  if (err?.name === 'MeilisearchApiError') {
    const status = err.response?.status;
    return typeof status === 'number' && status >= 500;
  }
  return false;
}

/**
 * @param {number} attempt 1-based attempt number that just failed
 * @param {number} baseDelayMs
 * @returns {number}
 */
export function exponentialDelayMs(attempt, baseDelayMs) {
  return baseDelayMs * 2 ** (attempt - 1);
}

/**
 * Runs `operation`, retrying on retryable failures with exponential backoff.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{
 *   attempts?: number,
 *   baseDelayMs?: number,
 *   isRetryable?: (error: unknown) => boolean,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [options]
 * @returns {Promise<T>}
 */
export async function retryMeiliCall(
  operation,
  {
    attempts = 3,
    baseDelayMs = 1000,
    isRetryable = isRetryableMeiliError,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts || !isRetryable(error)) throw error;
      await sleep(exponentialDelayMs(attempt, baseDelayMs));
    }
  }
  throw new Error('retryMeiliCall attempts must be at least 1');
}
