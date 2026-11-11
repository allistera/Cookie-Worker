// Cloudflare's automatic `hyperdrive_connect` span records that a connection
// was opened and nothing else: not what ran, how long it took, how many rows
// came back or why it failed. This wraps a postgres.js client so every query
// gets a span of its own, named after its operation (`SELECT`, `INSERT`,
// `COMMIT`) and carrying the OpenTelemetry database attributes, and so every
// query is timed into Analytics Engine whether or not the invocation is
// traced (shared/sqlMetrics.js). Query text and parameters are never
// recorded; a statement is identified by a hash of its static text.

import { recordQuery, sqlMetricsScope } from './sqlMetrics.js';
import { activeSpan, endSpanWithError, errorType, startSpan } from './tracing.js';

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
 * A fragment built with the client's tag and interpolated into a statement.
 *
 * @param {unknown} value
 * @returns {value is {strings: readonly string[], args?: readonly unknown[]}}
 */
function isFragment(value) {
  return Array.isArray(/** @type {{strings?: unknown}} */ (value)?.strings);
}

/**
 * The text the developer wrote, with `$` where a value goes. Interpolated
 * fragments are followed, because they decide which statement actually runs.
 *
 * @param {readonly string[]} strings
 * @param {readonly unknown[]} args
 * @param {number} depth
 * @returns {string}
 */
function staticText(strings, args, depth) {
  let text = '';
  for (let index = 0; index < strings.length; index += 1) {
    text += strings[index];
    if (index === strings.length - 1) break;
    const fragments = [args[index]].flat().filter(isFragment);
    text +=
      depth < 4 && fragments.length > 0
        ? fragments
            .map((fragment) => `(${staticText(fragment.strings, fragment.args ?? [], depth + 1)})`)
            .join(' ')
        : '$';
  }
  return text;
}

/**
 * A short, stable name for a statement: the FNV-1a hash of its static text
 * with whitespace collapsed. The same statement gives the same fingerprint
 * in every Worker and for every set of parameters, including value lists of
 * different lengths, and nothing of the statement can be read back from it.
 *
 * @param {readonly string[]} strings
 * @param {readonly unknown[]} [args]
 */
export function statementFingerprint(strings, args = []) {
  const text = staticText(strings, args, 0).replace(/\s+/gu, ' ').trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * postgres.js runs a query when it is first awaited (`handle`) and settles it
 * through `resolve`/`reject`, which the connection calls. Hooking those three
 * on the instance times the query without touching the driver.
 *
 * @param {unknown} value
 * @returns {value is {handle: () => Promise<void>, resolve: (x: unknown) => void, reject: (e: unknown) => void, strings: readonly string[], args?: readonly unknown[], executed: boolean}}
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
 * Wrap a postgres.js client so each query it runs is a span in a traced
 * invocation and a data point wherever query metrics are on. Returns the
 * client untouched when neither applies. Transactions (`sql.begin`,
 * savepoints) hand their scoped client through the same wrapper.
 *
 * @template {import('postgres').Sql} T
 * @param {T} sql
 * @param {import('./tracing.js').SpanAttributes} attributes
 * @returns {T}
 */
export function instrumentSql(sql, attributes) {
  if (!activeSpan() && !sqlMetricsScope()) return sql;
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
      // The scope is read here, in the caller's context: the connection
      // settles the query from its own.
      const metrics = sqlMetricsScope();
      if (!this.executed && (metrics || activeSpan())) {
        const operation = operationName(this.strings);
        const fingerprint = statementFingerprint(this.strings, this.args);
        const span = startSpan(operation ?? 'postgresql', {
          ...attributes,
          'db.operation.name': operation,
          'cookie.db.query.fingerprint': fingerprint,
        });
        // What the caller waits for: Hyperdrive, the network and the
        // database together. A Worker's clock moves on I/O, which a query is.
        const started = Date.now();
        /** @param {string} outcome @param {number} rows */
        const record = (outcome, rows) => {
          if (!metrics) return;
          recordQuery(metrics, {
            operation: operation ?? 'postgresql',
            fingerprint,
            outcome,
            durationMs: Date.now() - started,
            rows,
          });
        };
        const { resolve, reject } = this;
        this.resolve = (result) => {
          const rows = /** @type {{count?: unknown, length?: unknown}} */ (result ?? {});
          const count = typeof rows.count === 'number' ? rows.count : rows.length;
          if (span) {
            if (typeof count === 'number') span.setAttribute('db.response.returned_rows', count);
            span.end();
          }
          record('ok', typeof count === 'number' ? count : 0);
          return resolve(result);
        };
        this.reject = (err) => {
          if (span) endSpanWithError(span, err);
          record(errorType(err), 0);
          return reject(err);
        };
      }
      return handle.call(this);
    };
    return query;
  }
}
