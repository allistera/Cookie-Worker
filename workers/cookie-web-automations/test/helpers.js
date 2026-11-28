import { vi } from 'vitest';

/**
 * A postgres.js-shaped tagged-template mock. Each call to the returned `sql`
 * consumes the next queued result (FIFO) — tests queue results in the order
 * the handler under test is expected to issue queries. `sql.begin(callback)`
 * runs the callback with the same mock, so a transaction's queries draw from
 * the same queue as everything around it. `sql.json(value)` hands the value
 * back, so a test reads the object the query was given.
 *
 * @param {unknown[][]} results
 * @returns {any} Shaped like postgres.js's Sql, loosely typed so tests can
 *   pass it wherever the real thing is expected.
 */
export function createMockSql(results = []) {
  const queue = [...results];
  /** @type {{text: string, values: unknown[]}[]} */
  const calls = [];

  /** @type {any} */
  const sql = vi.fn((strings, ...values) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(queue.length ? queue.shift() : []);
  });
  sql.begin = vi.fn(async (/** @type {(sql: any) => unknown} */ callback) => callback(sql));
  sql.json = (/** @type {unknown} */ value) => value;
  sql.end = vi.fn(async () => undefined);
  sql.calls = calls;
  return sql;
}

/**
 * A stand-in for cookie-web-tasks' Internal entrypoint that answers every
 * call with `respond(call)` and remembers what it was asked.
 *
 * @param {(call: {method: string, path: string, body?: any}) => {status: number, body?: unknown}} [respond]
 */
export function createTasksService(respond = () => ({ status: 200, body: {} })) {
  /** @type {{identity: unknown, call: {method: string, path: string, body?: any}}[]} */
  const calls = [];
  return {
    calls,
    call: vi.fn(async (identity, call) => {
      calls.push({ identity, call });
      return { body: null, ...respond(call) };
    }),
  };
}
