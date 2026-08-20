import { describe, expect, test } from 'vitest';
import { applyLabelRules, fieldValue, matchesCondition, matchesRule } from '../src/rules.js';
import { createMockSql } from './helpers.js';

function record(overrides = {}) {
  return {
    fromName: 'Billing Dept',
    fromAddress: 'billing@example.com',
    subject: 'Your March Invoice is ready',
    bodyText: 'Please find your invoice attached.',
    recipients: { to: [{ name: 'Alice', address: 'alice@example.com' }], cc: [], bcc: [] },
    ...overrides,
  };
}

describe('fieldValue', () => {
  test('reads subject and body directly', () => {
    expect(fieldValue(record(), 'subject')).toBe('Your March Invoice is ready');
    expect(fieldValue(record(), 'body')).toBe('Please find your invoice attached.');
  });

  test('combines from name and address', () => {
    expect(fieldValue(record(), 'from')).toBe('Billing Dept billing@example.com');
  });

  test('falls back to the address alone when there is no from name', () => {
    expect(fieldValue(record({ fromName: null }), 'from')).toBe('billing@example.com');
  });

  test('joins every "to" recipient name and address', () => {
    const withTwo = record({
      recipients: { to: [{ name: 'Alice', address: 'alice@example.com' }, { name: null, address: 'bob@example.com' }] },
    });
    expect(fieldValue(withTwo, 'to')).toBe('Alice alice@example.com, bob@example.com');
  });

  test('returns empty string for missing fields', () => {
    expect(fieldValue(record({ subject: null }), 'subject')).toBe('');
    expect(fieldValue(record(), 'unknown')).toBe('');
  });
});

describe('matchesCondition', () => {
  test('contains is case-insensitive', () => {
    expect(matchesCondition(record(), { field: 'subject', operator: 'contains', value: 'INVOICE' })).toBe(true);
    expect(matchesCondition(record(), { field: 'subject', operator: 'contains', value: 'refund' })).toBe(false);
  });

  test('equals requires an exact match', () => {
    expect(matchesCondition(record(), { field: 'from', operator: 'equals', value: 'billing dept billing@example.com' })).toBe(true);
    expect(matchesCondition(record(), { field: 'from', operator: 'equals', value: 'billing@example.com' })).toBe(false);
  });

  test('starts_with and ends_with anchor to the edges', () => {
    expect(matchesCondition(record(), { field: 'subject', operator: 'starts_with', value: 'your march' })).toBe(true);
    expect(matchesCondition(record(), { field: 'subject', operator: 'starts_with', value: 'march' })).toBe(false);
    expect(matchesCondition(record(), { field: 'subject', operator: 'ends_with', value: 'is ready' })).toBe(true);
  });

  test('an empty value never matches', () => {
    expect(matchesCondition(record(), { field: 'subject', operator: 'contains', value: '' })).toBe(false);
  });

  test('an unknown operator never matches', () => {
    expect(matchesCondition(record(), { field: 'subject', operator: 'regex', value: 'invoice' })).toBe(false);
  });
});

describe('matchesRule', () => {
  const invoiceCondition = { field: 'subject', operator: 'contains', value: 'invoice' };
  const refundCondition = { field: 'subject', operator: 'contains', value: 'refund' };

  test('all requires every condition to match', () => {
    expect(matchesRule(record(), { matchType: 'all', conditions: [invoiceCondition] })).toBe(true);
    expect(matchesRule(record(), { matchType: 'all', conditions: [invoiceCondition, refundCondition] })).toBe(false);
  });

  test('any requires only one condition to match', () => {
    expect(matchesRule(record(), { matchType: 'any', conditions: [invoiceCondition, refundCondition] })).toBe(true);
    expect(matchesRule(record(), { matchType: 'any', conditions: [refundCondition] })).toBe(false);
  });

  test('a rule with no conditions never matches', () => {
    expect(matchesRule(record(), { matchType: 'all', conditions: [] })).toBe(false);
  });
});

describe('applyLabelRules', () => {
  test('applies only rules whose conditions match, tagged with source and rule_id', async () => {
    const sql = createMockSql({
      ruleRows: [
        { rule_id: 'rule-1', label_id: 'label-1', match_type: 'all', field: 'subject', operator: 'contains', value: 'invoice' },
        { rule_id: 'rule-2', label_id: 'label-2', match_type: 'all', field: 'subject', operator: 'contains', value: 'refund' },
      ],
    });

    const applied = await sql.begin(async (tx) => applyLabelRules(tx, 'user-1', 'message-1', record()));

    expect(applied).toBe(1);
    const inserts = sql.transactions[0].filter((q) => q.text.includes('INSERT INTO message_labels'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toEqual(['message-1', 'label-1', 'rule-1']);
    expect(inserts[0].text).toContain("'rule'");
  });

  test('groups multiple conditions under one rule and evaluates match_type', async () => {
    const sql = createMockSql({
      ruleRows: [
        { rule_id: 'rule-1', label_id: 'label-1', match_type: 'any', field: 'subject', operator: 'contains', value: 'refund' },
        { rule_id: 'rule-1', label_id: 'label-1', match_type: 'any', field: 'from', operator: 'contains', value: 'billing@' },
      ],
    });

    const applied = await sql.begin(async (tx) => applyLabelRules(tx, 'user-1', 'message-1', record()));

    expect(applied).toBe(1);
    expect(sql.transactions[0].filter((q) => q.text.includes('INSERT INTO message_labels'))).toHaveLength(1);
  });

  test('applies nothing when no rules are enabled', async () => {
    const sql = createMockSql({ ruleRows: [] });
    const applied = await sql.begin(async (tx) => applyLabelRules(tx, 'user-1', 'message-1', record()));
    expect(applied).toBe(0);
    expect(sql.transactions[0]).toHaveLength(1);
  });

  test('archives matching mail for mark_done instead of inserting a null label', async () => {
    const sql = createMockSql({
      ruleRows: [
        {
          rule_id: 'rule-done',
          label_id: null,
          action: 'mark_done',
          match_type: 'all',
          field: 'subject',
          operator: 'contains',
          value: 'invoice',
        },
      ],
    });

    const applied = await sql.begin(async (tx) => applyLabelRules(tx, 'user-1', 'message-1', record()));

    expect(applied).toBe(1);
    const labels = sql.transactions[0].filter((q) => q.text.includes('INSERT INTO message_labels'));
    expect(labels).toHaveLength(0);
    const archives = sql.transactions[0].filter((q) => q.text.includes('UPDATE messages'));
    expect(archives).toHaveLength(1);
    expect(archives[0].text).toContain('is_archived');
    expect(archives[0].values).toEqual(['message-1', 'user-1']);
  });
});
