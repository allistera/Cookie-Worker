import { vi } from 'vitest';

/**
 * @param {string} raw
 * @param {{from?: string, to?: string, rawSize?: number}} [options]
 * @returns {any}
 */
export function fakeMessage(raw, options = {}) {
  return {
    from: options.from ?? 'sender@example.com',
    to: options.to ?? 'inbox@example.org',
    raw,
    rawSize: options.rawSize ?? new TextEncoder().encode(raw).byteLength,
    forward: vi.fn(async () => undefined),
    setReject: vi.fn(),
  };
}

/**
 * @param {{lookupRows?: unknown[], transactionRejects?: boolean, messageInsertReturns?: unknown[], ruleRows?: unknown[]}} [options]
 * @returns {any}
 */
export function createMockSql(options = {}) {
  /** @type {{text: string, values: unknown[]}[]} */
  const queries = [];
  /** @type {{text: string, values: unknown[]}[][]} */
  const transactions = [];

  /**
   * @param {{text: string, values: unknown[]}[]} sink
   */
  const tagged = (sink) => (strings, ...values) => {
    const query = { text: strings.join('?'), values };
    sink.push(query);
    if (query.text.includes('SELECT') && query.text.includes('FROM users')) {
      return Promise.resolve(options.lookupRows ?? [{
        user_id: 'user-1',
        is_duplicate: false,
        thread_id: null,
      }]);
    }
    // Message insert uses RETURNING id to detect concurrent DO NOTHING races.
    if (query.text.includes('INSERT INTO messages') && query.text.includes('RETURNING')) {
      return Promise.resolve(options.messageInsertReturns ?? [{ id: 'message-1' }]);
    }
    if (query.text.includes('FROM label_rules')) {
      return Promise.resolve(options.ruleRows ?? []);
    }
    return Promise.resolve([]);
  };

  /** @type {any} */
  const sql = tagged(queries);
  // Mirrors postgres.js sql.begin: runs the callback with a transaction-scoped
  // sql, recording the statements it executes as one batch.
  sql.begin = async (callback) => {
    if (options.transactionRejects) throw new Error('transaction failed');
    /** @type {{text: string, values: unknown[]}[]} */
    const batch = [];
    transactions.push(batch);
    return callback(tagged(batch));
  };
  sql.end = vi.fn(async () => undefined);
  sql.queries = queries;
  sql.transactions = transactions;
  return sql;
}

export const simpleFixture = `From: Alice <alice@example.com>
To: Inbox <inbox@example.org>
Subject: Hello there
Message-ID: <simple@example.com>
Date: Wed, 08 Jul 2026 12:00:00 +0000
Content-Type: text/plain; charset=utf-8

This is a simple message body.
`;
