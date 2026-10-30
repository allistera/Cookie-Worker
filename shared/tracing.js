// Cloudflare's automatic Workers traces (exported to Honeycomb, see each
// wrangler.jsonc) already record every handler invocation, outbound fetch and
// Hyperdrive connect. This module adds what they leave out: a route template
// on request spans, a span per database query, outcomes of work a handler
// chose to continue past, and handled errors. Everything is a no-op when the
// invocation is not traced (sampling, tracing disabled, Vitest).
//
// Attribute policy, same as the structured logs: operation names, outcomes,
// counts, status codes and durations. Never URLs with tokens, user or mailbox
// identifiers, message content, SQL parameters or secrets.

import { tracing } from 'cloudflare:workers';

/** @typedef {Record<string, string | number | boolean | undefined>} SpanAttributes */

/**
 * The span of the current invocation (or the innermost custom span), only
 * while it is actually being traced.
 *
 * @returns {Span | undefined}
 */
export function activeSpan() {
  const span = tracing?.getActiveSpan?.();
  return span?.isTraced ? span : undefined;
}

/**
 * @param {SpanAttributes} attributes
 */
export function setSpanAttributes(attributes) {
  activeSpan()?.setAttributes(attributes);
}

/**
 * A child span that never becomes the active one, for leaf work such as a
 * database query. Returns undefined when the invocation is not traced, so the
 * caller does no work at all.
 *
 * @param {string} name
 * @param {SpanAttributes} [attributes]
 * @returns {Span | undefined}
 */
export function startSpan(name, attributes) {
  if (!activeSpan()) return undefined;
  const span = tracing.startSpan(name);
  if (!span?.isTraced) return undefined;
  if (attributes) span.setAttributes(attributes);
  return span;
}

/**
 * OpenTelemetry `error.type`: the error's own code when it has one (a
 * SQLSTATE, postgres.js's CONNECT_TIMEOUT, an HTTP status), else its class.
 *
 * @param {unknown} err
 */
export function errorType(err) {
  const code = /** @type {{code?: unknown}} */ (err)?.code;
  if (typeof code === 'string' && code) return code;
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  if (err instanceof Error && err.name) return err.name;
  return '_OTHER';
}

/**
 * Attach an error the Worker handled itself to the active span, so the trace
 * explains a slow or partial request without a trip to Sentry. The span's
 * status is left alone: a handled failure does not make the request fail.
 *
 * @param {Error} err Already stripped of secrets by the caller.
 * @param {string} operation The same name the Sentry capture uses.
 */
export function recordHandledError(err, operation) {
  const span = activeSpan();
  if (!span) return;
  span.recordException({ name: err.name || 'Error', message: err.message, stack: err.stack });
  span.setAttributes({ 'error.type': errorType(err), 'cookie.error.operation': operation });
}

/**
 * Mark a failed span the OpenTelemetry way: error status, `error.type` and
 * the exception, then end it.
 *
 * @param {Span} span
 * @param {unknown} err
 */
export function endSpanWithError(span, err) {
  const type = errorType(err);
  const error = err instanceof Error ? err : new Error(String(err));
  span.recordException({ name: error.name || 'Error', message: error.message, stack: error.stack });
  span.setAttributes({ 'error.type': type });
  span.setStatus({ code: 'error', message: type });
  span.end();
}

// A path segment that is an identifier rather than a route word: a UUID, a
// number, a hex id, or a long token containing a digit. Route words such as
// `calendar-subscriptions` have no digits and stay as they are.
const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[^/]*\d)[A-Za-z0-9_-]{20,})(\.[A-Za-z0-9]+)?$/iu;

/**
 * The low-cardinality shape of a request path, for `http.route`: identifier
 * segments become `{id}`, so `/messages/7f3a…/labels` groups with every other
 * message's labels and no identifier reaches the trace.
 *
 * @param {string} pathname
 */
export function routeTemplate(pathname) {
  const route = pathname
    .split('/')
    .map((segment) => segment.replace(ID_SEGMENT, '{id}$1'))
    .join('/');
  return route.length > 200 ? `${route.slice(0, 200)}…` : route || '/';
}

/**
 * Name the invocation span after the route the way an HTTP framework would
 * (`GET /messages/{id}`) instead of the bare method Cloudflare assigns, and
 * set `http.route`, so health probes and real traffic can be told apart.
 *
 * @param {Request} request
 */
export function labelRequestSpan(request) {
  const span = activeSpan();
  if (!span) return;
  const route = routeTemplate(new URL(request.url).pathname);
  span.setAttribute('http.route', route);
  span.updateName(`${request.method} ${route}`);
}
