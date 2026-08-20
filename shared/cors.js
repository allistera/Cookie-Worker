// Cookie-Web's SPA calls these Workers directly from the browser, cross-origin
// (unlike the other Workers, which only ever talk server-to-server over a
// bearer token) — so responses need real CORS headers, and preflight OPTIONS
// requests need answering before any auth check runs.

const ALLOWED_HEADERS = 'Authorization, Content-Type';
const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';

/**
 * @param {string | null} origin The request's Origin header.
 * @param {string | undefined} productionOrigin Cookie-Web's exact production
 *   origin, from the Worker's ALLOWED_ORIGIN var.
 */
export function isAllowedOrigin(origin, productionOrigin, environment) {
  if (!origin) return false;
  if (origin === productionOrigin) return true;
  if (origin.startsWith('http://localhost:')) {
    return environment !== 'production';
  }
  try {
    const url = new URL(origin);
    // Vercel preview deployments get an unpredictable per-PR subdomain.
    return url.protocol === 'https:' && url.hostname.endsWith('.vercel.app');
  } catch {
    return false;
  }
}

/**
 * @param {string | null} origin
 * @param {string | undefined} productionOrigin
 * @returns {Record<string, string> | null} null when the origin is not allowed.
 */
export function corsHeaders(origin, productionOrigin, environment) {
  if (!isAllowedOrigin(origin, productionOrigin, environment)) return null;
  return {
    'Access-Control-Allow-Origin': /** @type {string} */ (origin),
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Answers a CORS preflight request. Not gated on auth — the browser sends it
 * with no Authorization header by definition.
 *
 * @param {string | null} origin
 * @param {string | undefined} productionOrigin
 */
export function preflightResponse(origin, productionOrigin, environment) {
  const headers = corsHeaders(origin, productionOrigin, environment);
  return new Response(null, { status: headers ? 204 : 403, headers: headers ?? {} });
}

/**
 * Adds CORS headers to an otherwise-finished response. Returns the response
 * unchanged when the origin isn't allowed — the browser will block it
 * client-side, same as a preflight failure would.
 *
 * @param {Response} response
 * @param {string | null} origin
 * @param {string | undefined} productionOrigin
 */
export function withCors(response, origin, productionOrigin, environment) {
  const headers = corsHeaders(origin, productionOrigin, environment);
  if (!headers) return response;
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, { status: response.status, headers: merged });
}
