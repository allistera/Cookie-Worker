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
 * @param {{lookupRows?: unknown[], transactionRejects?: boolean}} options
 */
export function createMockSql(options = {}) {
  const queries = [];
  const transactions = [];
  const sql = (strings, ...values) => {
    const query = { text: strings.join('?'), values };
    queries.push(query);
    if (query.text.includes('SELECT') && query.text.includes('FROM users')) {
      return Promise.resolve(options.lookupRows ?? [{
        user_id: 'user-1',
        is_duplicate: false,
        thread_id: null,
      }]);
    }
    return query;
  };
  sql.transaction = async (statements) => {
    transactions.push(statements);
    if (options.transactionRejects) throw new Error('transaction failed');
    return [];
  };
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
