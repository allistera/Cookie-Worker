/**
 * Retry an operation with linear backoff.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation
 * @param {{attempts?: number, baseDelayMs?: number, isRetryable?: (error: unknown) => boolean}} [options]
 * @returns {Promise<T>}
 */
export async function retryWithBackoff(
  operation,
  { attempts = 3, baseDelayMs = 1000, isRetryable = () => true } = {},
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt === attempts || !isRetryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
  throw new Error('retry attempts must be at least 1');
}
