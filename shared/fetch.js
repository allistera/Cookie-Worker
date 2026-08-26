export const FETCH_TIMEOUT_MS = 15_000;

/**
 * Keep one deadline active through both response headers and body parsing.
 * `fetchImpl` lets a service binding's fetch flow through the same deadline.
 *
 * @template T
 * @param {string | URL | Request} input
 * @param {RequestInit} init
 * @param {(response: Response) => Promise<T>} consume
 * @param {number} [timeoutMs]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<T>}
 */
export async function fetchWithTimeout(
  input,
  init,
  consume,
  timeoutMs = FETCH_TIMEOUT_MS,
  fetchImpl = fetch,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a response body as text while enforcing a byte ceiling, so an
 * unexpectedly huge external payload aborts instead of buffering toward the
 * isolate's memory limit. For bodies from services we do not control.
 *
 * @param {Response} response
 * @param {number} maxBytes
 */
export async function readTextCapped(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    // No streaming body (test stubs, polyfills): read whole, then enforce.
    const text = await response.text();
    if (text.length > maxBytes) throw new Error(`Response exceeded ${maxBytes} bytes`);
    return text;
  }
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
