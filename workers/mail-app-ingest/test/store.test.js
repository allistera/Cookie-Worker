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
    expect(sql.transactions[0]).toHaveLength(4);
    expect(sql.transactions[0][0].text).toContain('INSERT INTO threads');
    expect(sql.transactions[0][0].text).toContain('message_count');
    expect(sql.transactions[0][0].values).toContain(1);
    expect(sql.transactions[0][1].text).toContain('INSERT INTO messages');
    expect(sql.transactions[0][1].text).toContain('RETURNING');
    expect(sql.transactions[0][2].text).toContain('INSERT INTO message_ai');
    expect(sql.transactions[0][3].text).toContain('FROM label_rules');
  });

  test('applies a matching tag rule in the same transaction as the insert', async () => {
    const sql = createMockSql({
      ruleRows: [
        { rule_id: 'rule-1', label_id: 'label-1', match_type: 'all', field: 'subject', operator: 'contains', value: 'subject' },
      ],
    });
    const result = await storeEmail(sql, record(), 'owner@example.com');

    expect(result.outcome).toBe('inserted');
    const ruleInsert = sql.transactions[0].find((q) => q.text.includes('INSERT INTO message_labels'));
    expect(ruleInsert.values).toEqual([result.messageUuid, 'label-1', 'rule-1']);
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
    expect(sql.transactions[0]).toHaveLength(4);
    expect(sql.transactions[0][0].text).toContain('INSERT INTO messages');
    expect(sql.transactions[0][1].text).toContain('INSERT INTO message_ai');
    expect(sql.transactions[0][2].text).toContain('FROM label_rules');
    expect(sql.transactions[0][3].text).toContain('UPDATE threads');
  });

  test('returns duplicate when concurrent insert wins (RETURNING empty)', async () => {
    const sql = createMockSql({
      lookupRows: [{ user_id: 'u', is_duplicate: false, thread_id: 'thread-1' }],
      messageInsertReturns: [],
    });
    await expect(storeEmail(sql, record(), 'owner@example.com')).resolves.toEqual({
      outcome: 'duplicate',
      messageUuid: null,
    });
    // Message insert ran; attachments/counter update did not. Existing thread is kept.
    expect(sql.transactions[0]).toHaveLength(1);
    expect(sql.transactions[0][0].text).toContain('INSERT INTO messages');
  });

  test('deletes empty thread when concurrent insert wins on a new thread', async () => {
    const sql = createMockSql({ messageInsertReturns: [] });
    await expect(storeEmail(sql, record(), 'owner@example.com')).resolves.toEqual({
      outcome: 'duplicate',
      messageUuid: null,
    });
    expect(sql.transactions[0][0].text).toContain('INSERT INTO threads');
    expect(sql.transactions[0][1].text).toContain('INSERT INTO messages');
    expect(sql.transactions[0][2].text).toContain('DELETE FROM threads');
  });

  test('throws when no user matches', async () => {
    const sql = createMockSql({ lookupRows: [] });
    await expect(storeEmail(sql, record(), 'missing@example.com')).rejects.toThrow('no users row matches');
  });

  test('persists an uploaded attachment blob URL', async () => {
    const sql = createMockSql();
    await storeEmail(sql, record({
      attachments: [{
        filename: null,
        mime_type: 'text/plain',
        size: 3,
        blob_url: 'https://store.private.blob.vercel-storage.com/mail-attachments/hash/0',
      }],
    }), 'owner@example.com');
    const attachmentStatement = sql.transactions[0].find((statement) => statement.text.includes('INSERT INTO attachments'));
    expect(attachmentStatement.text).toContain('blob_url');
    expect(attachmentStatement.values).toContain(
      'https://store.private.blob.vercel-storage.com/mail-attachments/hash/0',
    );
  });

  test('propagates transaction failures', async () => {
    const sql = createMockSql({ transactionRejects: true });
    await expect(storeEmail(sql, record(), 'owner@example.com')).rejects.toThrow('transaction failed');
  });
});
