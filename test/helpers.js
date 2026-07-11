import { vi } from 'vitest';

/**
 * @param {string} raw
 * @param {{from?: string, to?: string, rawSize?: number}} options
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
 * @param {{lookupRows?: unknown[], transactionRejects?: boolean, messageInsertReturns?: unknown[]}} options
 */
export function createMockSql(options = {}) {
  const queries = [];
  const transactions = [];
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
    return Promise.resolve([]);
  };
  const sql = tagged(queries);
  // Mirrors postgres.js sql.begin: runs the callback with a transaction-scoped
  // sql, recording the statements it executes as one batch.
  sql.begin = async (callback) => {
    if (options.transactionRejects) throw new Error('transaction failed');
    const batch = [];
    transactions.push(batch);
    await callback(tagged(batch));
    return [];
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
