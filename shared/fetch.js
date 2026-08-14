export const FETCH_TIMEOUT_MS = 15_000;

/**
 * Keep one deadline active through both response headers and body parsing.
 *
 * @template T
 * @param {string | URL | Request} input
 * @param {RequestInit} init
 * @param {(response: Response) => Promise<T>} consume
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function fetchWithTimeout(input, init, consume, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}
