import { vi } from 'vitest';

/**
 * A postgres.js-shaped tagged-template mock. Each call to the returned `sql`
 * consumes the next queued result (FIFO) — tests queue results in the order
 * the handler under test is expected to issue queries.
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
  sql.calls = calls;
  return sql;
}
