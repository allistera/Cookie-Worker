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
 * @param {{lookupRows?: unknown[], transactionRejects?: boolean, messageInsertReturns?: unknown[], ruleRows?: unknown[], aiRuleRows?: unknown[], labelRows?: unknown[], categoryRows?: unknown[], enrichmentStateRows?: unknown[], lockedAiRows?: unknown[]}} [options]
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
  const tagged = (sink) => {
    const fn = (strings, ...values) => {
      const query = { text: strings.join('?'), values };
      sink.push(query);
      if (query.text.includes('SELECT') && query.text.includes('FROM users')) {
        return Promise.resolve(
          options.lookupRows ?? [
            {
              user_id: 'user-1',
              is_duplicate: false,
              thread_id: null,
            },
          ],
        );
      }
      // Transaction-scoped duplicate/thread lookup (post advisory-lock), keyed
      // on the already-resolved user id rather than a users join.
      if (query.text.includes('AS is_duplicate') && query.text.includes('AS thread_id')) {
        return Promise.resolve(
          options.lookupRows ?? [
            {
              user_id: 'user-1',
              is_duplicate: false,
              thread_id: null,
            },
          ],
        );
      }
      // Message insert uses RETURNING id to detect concurrent DO NOTHING races.
      if (query.text.includes('INSERT INTO messages') && query.text.includes('RETURNING')) {
        return Promise.resolve(options.messageInsertReturns ?? [{ id: 'message-1' }]);
      }
      if (query.text.includes("l.kind = 'user'")) {
        return Promise.resolve(options.labelRows ?? []);
      }
      if (query.text.includes('FROM email_categories')) {
        return Promise.resolve(options.categoryRows ?? []);
      }
      if (query.text.includes('FROM label_rules')) {
        return Promise.resolve(
          query.text.includes("r.kind = 'ai'")
            ? (options.aiRuleRows ?? [])
            : (options.ruleRows ?? []),
        );
      }
      if (query.text.includes('LEFT JOIN message_ai')) {
        return Promise.resolve(options.enrichmentStateRows ?? []);
      }
      if (
        query.text.includes('FROM message_ai WHERE message_id') &&
        query.text.includes('FOR UPDATE')
      ) {
        return Promise.resolve(options.lockedAiRows ?? []);
      }
      return Promise.resolve([]);
    };
    // Mirrors postgres.js's sql.json: marks a value to be sent as a real jsonb
    // parameter instead of pre-stringifying it into a jsonb string scalar.
    fn.json = (value) => ({ __pgJson: value });
    return fn;
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
