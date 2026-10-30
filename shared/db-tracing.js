// Cloudflare's automatic `hyperdrive_connect` span records that a connection
// was opened and nothing else: not what ran, how long it took, how many rows
// came back or why it failed. This wraps a postgres.js client so every query
// gets a span of its own, named after its operation (`SELECT`, `INSERT`,
// `COMMIT`) and carrying the OpenTelemetry database attributes. Query text
// and parameters are never recorded.

import { activeSpan, endSpanWithError, startSpan } from './tracing.js';

/**
 * Connection-level attributes, shared by every query span of one client. The
 * host is Hyperdrive's, not the origin database's; credentials are not read.
 *
 * @param {string} databaseUrl
 * @returns {import('./tracing.js').SpanAttributes}
 */
export function connectionAttributes(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    const database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
    return {
      'db.system.name': 'postgresql',
      'server.address': url.hostname || undefined,
      'server.port': Number(url.port) || 5432,
      'db.namespace': database || undefined,
    };
  } catch {
    return { 'db.system.name': 'postgresql' };
  }
}

const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u;

/**
 * The first keyword of a statement, upper-cased, or undefined when the
 * statement starts with an interpolated fragment.
 *
 * @param {readonly string[]} strings
 */
export function operationName(strings) {
  const match = /^[A-Za-z]+/u.exec((strings[0] ?? '').replace(LEADING_COMMENTS, ''));
  return match ? match[0].toUpperCase() : undefined;
}

/**
 * postgres.js runs a query when it is first awaited (`handle`) and settles it
 * through `resolve`/`reject`, which the connection calls. Hooking those three
 * on the instance times the query without touching the driver.
 *
 * @param {unknown} value
 * @returns {value is {handle: () => Promise<void>, resolve: (x: unknown) => void, reject: (e: unknown) => void, strings: readonly string[], executed: boolean}}
 */
function isQuery(value) {
  if (!(value instanceof Promise)) return false;
  const query = /** @type {any} */ (value);
  return (
    typeof query.handle === 'function' &&
    typeof query.resolve === 'function' &&
    typeof query.reject === 'function' &&
    Array.isArray(query.strings)
  );
}

/**
 * Wrap a postgres.js client so each query it runs is a span. Returns the
 * client untouched when the invocation is not traced, so an unsampled
 * request pays nothing. Transactions (`sql.begin`, savepoints) hand their
 * scoped client through the same wrapper.
 *
 * @template {import('postgres').Sql} T
 * @param {T} sql
 * @param {import('./tracing.js').SpanAttributes} attributes
 * @returns {T}
 */
export function instrumentSql(sql, attributes) {
  if (!activeSpan()) return sql;
  return wrap(sql);

  /**
   * @template {object} C
   * @param {C} client
   * @returns {C}
   */
  function wrap(client) {
    return new Proxy(client, {
      apply(target, thisArg, args) {
        return traceQuery(Reflect.apply(/** @type {any} */ (target), thisArg, args));
      },
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        if (property === 'unsafe') {
          return (/** @type {unknown[]} */ ...args) => traceQuery(value.apply(target, args));
        }
        if (property === 'begin' || property === 'savepoint') {
          return (/** @type {unknown[]} */ ...args) => {
            const last = args.length - 1;
            const callback = args[last];
            if (typeof callback === 'function') {
              args[last] = (/** @type {object} */ scoped) => callback(wrap(scoped));
            }
            return value.apply(target, args);
          };
        }
        return value;
      },
    });
  }

  /**
   * @template Q
   * @param {Q} query
   * @returns {Q}
   */
  function traceQuery(query) {
    if (!isQuery(query)) return query;
    const handle = query.handle;
    query.handle = function () {
      if (!this.executed) {
        const operation = operationName(this.strings);
        const span = startSpan(operation ?? 'postgresql', {
          ...attributes,
          'db.operation.name': operation,
        });
        if (span) {
          const { resolve, reject } = this;
          this.resolve = (result) => {
            const rows = /** @type {{count?: unknown, length?: unknown}} */ (result ?? {});
            const count = typeof rows.count === 'number' ? rows.count : rows.length;
            if (typeof count === 'number') span.setAttribute('db.response.returned_rows', count);
            span.end();
            return resolve(result);
          };
          this.reject = (err) => {
            endSpanWithError(span, err);
            return reject(err);
          };
        }
      }
      return handle.call(this);
    };
    return query;
  }
}
