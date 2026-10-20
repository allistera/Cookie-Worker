/**
 * Shared request-body utilities for Cookie-Worker entry points.
 *
 * The helpers below replace duplicated `readJsonBody` implementations across
 * workers so fixes to error handling and size limits only need to happen once.
 */

export class BodyTooLargeError extends Error {}
export class InvalidJsonError extends Error {}
export class UnsupportedContentTypeError extends Error {}
export class InvalidFormError extends Error {}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * Bound the entire multipart stream, including ignored fields and framing,
 * before asking the runtime to parse it. Each allowed field occurs at most once.
 * @param {Request} request
 * @param {{maxBytes: number, fields: string[]}} options
 */
export async function readFormBody(request, { maxBytes, fields }) {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.split(';')[0].trim().toLowerCase() !== 'multipart/form-data') {
    throw new InvalidFormError('Content-Type must be multipart/form-data');
  }
  if (Number(request.headers.get('content-length')) > maxBytes) {
    throw new BodyTooLargeError('Payload too large');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidFormError('Missing multipart body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError('Payload too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let form;
  try {
    form = await new Response(new Blob(chunks), {
      headers: { 'content-type': contentType },
    }).formData();
  } catch (cause) {
    throw new InvalidFormError('Invalid multipart body', { cause });
  }
  const seen = new Set();
  for (const key of form.keys()) {
    if (!fields.includes(key) || seen.has(key)) {
      throw new InvalidFormError('Unexpected or duplicate multipart field');
    }
    seen.add(key);
  }
  return form;
}

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

  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let raw = '';
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          // Cancellation must not hold up the 413 response if the source stalls.
          void reader.cancel().catch(() => undefined);
          throw new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes`);
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
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
  if (error instanceof InvalidFormError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  return null;
}
