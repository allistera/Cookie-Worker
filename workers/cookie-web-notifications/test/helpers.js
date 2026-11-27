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

/**
 * Stubs global fetch so shared/safe-https.js's DNS-over-HTTPS lookups see
 * one address (public by default) and every other request goes to `target`.
 *
 * @param {(input: RequestInfo | URL, init?: RequestInit) => unknown} [target]
 * @param {string} [address]
 */
export function stubPublicDns(target = () => new Response(null, { status: 200 }), address) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (/** @type {RequestInfo | URL} */ input, /** @type {RequestInit} */ init) => {
      const url = new URL(String(input));
      if (url.hostname === 'cloudflare-dns.com') {
        const type = url.searchParams.get('type');
        return Response.json({
          Status: 0,
          Answer: type === 'A' ? [{ type: 1, data: address ?? '93.184.216.34' }] : [],
        });
      }
      return target(input, init);
    }),
  );
}
