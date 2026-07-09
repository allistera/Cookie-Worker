import { describe, expect, test } from 'vitest';
import { storeEmail } from '../src/store.js';
import { createMockSql } from './helpers.js';

function record(overrides = {}) {
  return {
    messageId: '<id@example.com>',
    references: [],
    fromName: 'Alice',
    fromAddress: 'alice@example.com',
    recipients: { to: [], cc: [], bcc: [] },
    subject: 'Subject',
    snippet: 'Snippet',
    bodyText: 'Body',
    bodyHtml: null,
    sentAt: new Date('2026-07-08T12:00:00Z'),
    headers: [],
    attachments: [],
    rawSize: 123,
    truncated: false,
    envelopeFrom: 'alice@example.com',
    envelopeTo: 'inbox@example.org',
    ...overrides,
  };
}

describe('storeEmail', () => {
  test('inserts a new thread and message', async () => {
    const sql = createMockSql();
    const result = await storeEmail(sql, record(), 'owner@example.com');
    expect(result.outcome).toBe('inserted');
    expect(result.messageUuid).toEqual(expect.any(String));
    expect(sql.transactions[0]).toHaveLength(2);
    expect(sql.transactions[0][0].text).toContain('INSERT INTO threads');
    expect(sql.transactions[0][1].text).toContain('INSERT INTO messages');
  });

  test('returns duplicate without writing', async () => {
    const sql = createMockSql({ lookupRows: [{ user_id: 'u', is_duplicate: true, thread_id: null }] });
    await expect(storeEmail(sql, record(), 'owner@example.com')).resolves.toEqual({
      outcome: 'duplicate',
      messageUuid: null,
    });
    expect(sql.transactions).toHaveLength(0);
  });

  test('reuses referenced thread and bumps counters', async () => {
    const sql = createMockSql({ lookupRows: [{ user_id: 'u', is_duplicate: false, thread_id: 'thread-1' }] });
    await storeEmail(sql, record({ references: ['<parent@example.com>'] }), 'owner@example.com');
    expect(sql.transactions[0]).toHaveLength(2);
    expect(sql.transactions[0][0].text).toContain('INSERT INTO messages');
    expect(sql.transactions[0][1].text).toContain('UPDATE threads');
  });

  test('throws when no user matches', async () => {
    const sql = createMockSql({ lookupRows: [] });
    await expect(storeEmail(sql, record(), 'missing@example.com')).rejects.toThrow('no users row matches');
  });

  test('inserts attachments with null blob_url', async () => {
    const sql = createMockSql();
    await storeEmail(sql, record({ attachments: [{ filename: null, mime_type: 'text/plain', size: 3 }] }), 'owner@example.com');
    const attachmentStatement = sql.transactions[0].find((statement) => statement.text.includes('INSERT INTO attachments'));
    expect(attachmentStatement.text).toContain('blob_url');
    expect(attachmentStatement.values).toContain(null);
  });

  test('propagates transaction failures', async () => {
    const sql = createMockSql({ transactionRejects: true });
    await expect(storeEmail(sql, record(), 'owner@example.com')).rejects.toThrow('transaction failed');
  });
});
