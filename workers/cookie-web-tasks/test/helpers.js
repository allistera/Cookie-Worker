import { vi } from 'vitest';

/**
 * A postgres.js-shaped tagged-template mock. Each call to the returned `sql`
 * consumes the next queued result (FIFO) — tests queue results in the order
 * the handler under test is expected to issue queries. `sql.begin(callback)`
 * runs the callback with the same mock, so a transaction's queries draw from
 * the same queue as everything around it. `sql.json(value)`/`sql.array(value)`
 * tag a value the way the driver would, and calling the mock with a plain
 * object (postgres.js's dynamic `SET ${sql(updates)}` helper, used by
 * documents.js's updateDocument) records the touched column names instead of
 * consuming the queue. Calling it with a plain string (postgres.js's
 * `${sql(name)}` dynamic identifier helper, used by ancestry.js) resolves to
 * an escaped-identifier marker without touching the call log or queue,
 * matching the real driver: resolving an identifier isn't a round trip.
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
  const sql = vi.fn((/** @type {any} */ strings, /** @type {any[]} */ ...values) => {
    if (typeof strings === 'string') {
      // postgres.js's `sql(name)` identifier helper: escapes a dynamic
      // table/column name. Resolving it isn't itself a driver round trip,
      // so — like the real client — it doesn't touch the call log or queue.
      return { __identifier: strings };
    }
    if (!Array.isArray(strings)) {
      calls.push({ text: `SET(${Object.keys(strings).join(',')})`, values: [] });
      return { __set: strings };
    }
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(queue.length ? queue.shift() : []);
  });
  sql.json = vi.fn((/** @type {any} */ value) => ({ __json: value }));
  sql.array = vi.fn((/** @type {any} */ value) => ({ __array: value }));
  sql.begin = vi.fn(async (/** @type {(sql: any) => unknown} */ callback) => callback(sql));
  sql.end = vi.fn(async () => undefined);
  sql.calls = calls;
  return sql;
}
