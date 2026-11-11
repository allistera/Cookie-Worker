// One Analytics Engine data point per database query: which Worker ran it,
// under which route or trigger, what kind of statement it was, how long the
// caller waited for it and how it ended. Trace spans describe the same query
// (shared/db-tracing.js) but only for sampled invocations; these points are
// written for every invocation, so latency and error objectives can be
// measured on all of the traffic.
//
// Same policy as the spans: never query text, parameters, table names, URLs
// or identities. A statement is told apart by a hash of its static text.
//
// Every wrangler.jsonc binds the shared `cookie_sql_queries` dataset as
// SQL_METRICS. Without the binding (Vitest, the AWS server) nothing is
// recorded and the database client is left untouched.

/// <reference path="./async-hooks.d.ts" />
import { AsyncLocalStorage } from 'node:async_hooks';
import { routeTemplate } from './tracing.js';

/**
 * @typedef {{
 *   dataset: {writeDataPoint: (point: {indexes: string[], blobs: string[], doubles: number[]}) => void},
 *   service: string,
 *   entry: string,
 *   written: number,
 * }} SqlMetricsScope
 */

// The scope travels with the invocation instead of through every createSql
// call site, and survives the awaits between a handler and its queries.
/** @type {AsyncLocalStorage<SqlMetricsScope>} */
const scope = new AsyncLocalStorage();

// Analytics Engine takes 250 data points per invocation. Stopping short of
// that leaves room for the response point (shared/responseMetrics.js); a
// sweep that runs more queries than this is described by its first ones.
export const MAX_QUERY_POINTS = 200;

const TRIGGERS = /** @type {const} */ (['fetch', 'scheduled', 'email', 'queue']);

/**
 * The scope of the invocation under way, or undefined outside one.
 *
 * @returns {SqlMetricsScope | undefined}
 */
export function sqlMetricsScope() {
  return scope.getStore();
}

/**
 * What the invocation is doing, in a form with no identifiers: the method and
 * route template of a request, the schedule of a cron tick, or the trigger.
 *
 * @param {string} trigger
 * @param {any} subject The handler's first argument.
 */
export function entryName(trigger, subject) {
  if (trigger === 'fetch') {
    try {
      return `${subject.method} ${routeTemplate(new URL(subject.url).pathname)}`;
    } catch {
      return trigger;
    }
  }
  if (trigger === 'scheduled' && subject?.cron) return `scheduled ${subject.cron}`;
  return trigger;
}

/**
 * Run `callback` with query metrics on, for work that starts outside a
 * wrapped handler (a Durable Object alarm).
 *
 * @template T
 * @param {{SQL_METRICS?: SqlMetricsScope['dataset']} | undefined} env
 * @param {string} service
 * @param {string} entry
 * @param {() => T} callback
 * @returns {T}
 */
export function runWithSqlMetrics(env, service, entry, callback) {
  const dataset = env?.SQL_METRICS;
  if (!dataset) return callback();
  return scope.run({ dataset, service, entry, written: 0 }, callback);
}

/**
 * Record the queries of every handler the Worker has. Preserve every other
 * property on the worker.
 *
 * @param {any} worker
 * @param {string} service
 */
export function withSqlMetrics(worker, service) {
  const instrumented = { ...worker };
  for (const trigger of TRIGGERS) {
    if (typeof worker[trigger] !== 'function') continue;
    instrumented[trigger] = (
      /** @type {any} */ subject,
      /** @type {any} */ env,
      /** @type {any} */ ctx,
    ) =>
      runWithSqlMetrics(env, service, entryName(trigger, subject), () =>
        worker[trigger](subject, env, ctx),
      );
  }
  return instrumented;
}

/**
 * @param {SqlMetricsScope} metrics
 * @param {{operation: string, fingerprint: string, outcome: string, durationMs: number, rows: number}} query
 */
export function recordQuery(metrics, { operation, fingerprint, outcome, durationMs, rows }) {
  if (metrics.written >= MAX_QUERY_POINTS) return;
  metrics.written += 1;
  try {
    metrics.dataset.writeDataPoint({
      indexes: [metrics.service],
      blobs: [metrics.service, metrics.entry, operation, fingerprint, outcome],
      doubles: [durationMs, rows],
    });
  } catch {
    // Metrics must never change the outcome of a query.
  }
}
