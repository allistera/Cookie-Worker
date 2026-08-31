/**
 * Shared request-body utilities for Cookie-Worker entry points.
 *
 * The helpers below replace duplicated `readJsonBody` implementations across
 * workers so fixes to error handling and size limits only need to happen once.
 */

export class BodyTooLargeError extends Error {}
export class InvalidJsonError extends Error {}
export class UnsupportedContentTypeError extends Error {}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads and parses a JSON request body with an explicit size cap and an
 * optional Content-Type check. Returns distinct error types so callers can map
 * them to the right HTTP status codes (413 vs 400 vs 415).
 *
 * @param {Request} request
 * @param {Object} [options]
 * @param {number} [options.maxBytes=65536]
 * @param {boolean} [options.requireContentType=false]
 * @returns {Promise<unknown>}
 * @throws {BodyTooLargeError | InvalidJsonError | UnsupportedContentTypeError}
 */
export async function readJsonBody(
  request,
  { maxBytes = DEFAULT_MAX_BODY_BYTES, requireContentType = false } = {},
) {
  if (requireContentType) {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.split(';')[0].trim().toLowerCase().startsWith('application/json')) {
      throw new UnsupportedContentTypeError('Content-Type must be application/json');
    }
  }

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes`);
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes`);
  }

  const raw = new TextDecoder().decode(bytes);
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new InvalidJsonError('Invalid JSON body', { cause });
  }
}

/**
 * Convenience error handler that maps shared body errors to standard
 * Response objects. Callers can chain their own logic after `readJsonBody`
 * and only use this helper for early returns.
 *
 * @param {unknown} error
 */
export function bodyErrorResponse(error) {
  if (error instanceof BodyTooLargeError) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }
  if (error instanceof UnsupportedContentTypeError) {
    return Response.json({ error: error.message }, { status: 415 });
  }
  if (error instanceof InvalidJsonError) {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  return null;
}
