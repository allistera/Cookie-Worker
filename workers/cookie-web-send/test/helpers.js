import { vi } from 'vitest';

/**
 * A postgres.js-shaped tagged-template mock. Each call to the returned `sql`
 * consumes the next queued result (FIFO) — tests queue results in the order
 * the handler under test is expected to issue queries. `sql.begin(callback)`
 * runs the callback with the same mock, so a transaction's queries draw from
 * the same queue as everything around it.
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
  sql.end = vi.fn(async () => undefined);
  sql.calls = calls;
  return sql;
}
