import { describe, expect, test } from 'vitest';
import { createRule, deleteRule, listRules, updateRule } from '../src/labelRules.js';
import { createMockSql } from './helpers.js';

const RULE_ID = '22222222-2222-2222-2222-222222222222';
const LABEL_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '99999999-9999-4999-8999-999999999999';

const CONDITIONS = [{ field: 'subject', operator: 'contains', value: 'invoice' }];

describe('listRules', () => {
  test('groups joined condition rows under their rule', async () => {
    const sql = createMockSql([
      [
        {
          id: RULE_ID,
          name: 'Invoices',
          label_id: LABEL_ID,
          action: 'apply_label',
          match_type: 'all',
          enabled: true,
          condition_id: 'c1',
          field: 'subject',
          operator: 'contains',
          value: 'invoice',
          position: 0,
        },
        {
          id: RULE_ID,
          name: 'Invoices',
          label_id: LABEL_ID,
          action: 'apply_label',
          match_type: 'all',
          enabled: true,
          condition_id: 'c2',
          field: 'from',
          operator: 'contains',
          value: 'billing',
          position: 1,
        },
      ],
    ]);
    const response = await listRules(sql, USER_ID);
    expect(response.status).toBe(200);
    const { rules } = await response.json();
    expect(rules).toHaveLength(1);
    expect(rules[0].conditions).toHaveLength(2);
  });

  test('returns an empty list when there are no rules', async () => {
    const sql = createMockSql([[]]);
    const response = await listRules(sql, USER_ID);
    expect(await response.json()).toEqual({ rules: [] });
  });
});

describe('createRule', () => {
  test('creates an apply_label rule and its conditions', async () => {
    const sql = createMockSql([
      [
        {
          id: RULE_ID,
          name: 'Invoices',
          label_id: LABEL_ID,
          action: 'apply_label',
          match_type: 'all',
          enabled: true,
        },
      ],
      [],
    ]);
    const response = await createRule(sql, USER_ID, {
      name: 'Invoices',
      action: 'apply_label',
      label_id: LABEL_ID,
      conditions: CONDITIONS,
    });
    expect(response.status).toBe(201);
    const { rule } = await response.json();
    expect(rule.conditions).toEqual([{ ...CONDITIONS[0], position: 0 }]);
  });

  test('creates a mark_done rule with no label', async () => {
    const sql = createMockSql([
      [
        {
          id: RULE_ID,
          name: null,
          label_id: null,
          action: 'mark_done',
          match_type: 'any',
          enabled: true,
        },
      ],
      [],
    ]);
    const response = await createRule(sql, USER_ID, {
      action: 'mark_done',
      match_type: 'any',
      conditions: CONDITIONS,
    });
    expect(response.status).toBe(201);
  });

  test('creates an AI rule from a prompt, with no condition rows', async () => {
    const sql = createMockSql([
      [
        {
          id: RULE_ID,
          name: 'Receipts',
          label_id: LABEL_ID,
          action: 'apply_label',
          kind: 'ai',
          prompt: 'Receipts and order confirmations from online shops',
          match_type: 'all',
          enabled: true,
        },
      ],
    ]);
    const response = await createRule(sql, USER_ID, {
      name: 'Receipts',
      kind: 'ai',
      prompt: '  Receipts and order confirmations from online shops ',
      action: 'apply_label',
      label_id: LABEL_ID,
    });
    expect(response.status).toBe(201);
    const { rule } = await response.json();
    expect(rule).toMatchObject({ kind: 'ai', conditions: [] });
    const insert = sql.calls.find((call) => call.text.includes('INSERT INTO label_rules'));
    expect(insert.values).toContain('Receipts and order confirmations from online shops');
    expect(sql.calls.some((call) => call.text.includes('INSERT INTO label_rule_conditions'))).toBe(
      false,
    );
  });

  test.each([
    ['an AI rule without a prompt', { kind: 'ai', action: 'apply_label', label_id: LABEL_ID }],
    [
      'an AI rule that also carries conditions',
      {
        kind: 'ai',
        prompt: 'Receipts',
        action: 'apply_label',
        label_id: LABEL_ID,
        conditions: CONDITIONS,
      },
    ],
    [
      'a conditions rule that also carries a prompt',
      { prompt: 'Receipts', action: 'apply_label', label_id: LABEL_ID, conditions: CONDITIONS },
    ],
    [
      'an unknown kind',
      { kind: 'regex', prompt: 'Receipts', action: 'apply_label', label_id: LABEL_ID },
    ],
  ])('rejects %s before querying the database', async (_name, body) => {
    const sql = createMockSql();
    const response = await createRule(sql, USER_ID, body);
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('rejects apply_label with no label_id before querying the database', async () => {
    const sql = createMockSql();
    const response = await createRule(sql, USER_ID, {
      action: 'apply_label',
      conditions: CONDITIONS,
    });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('rejects mark_done that also sets a label_id', async () => {
    const sql = createMockSql();
    const response = await createRule(sql, USER_ID, {
      action: 'mark_done',
      label_id: LABEL_ID,
      conditions: CONDITIONS,
    });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test.each([
    [[]],
    [Array.from({ length: 11 }, () => CONDITIONS[0])],
    [[{ field: 'unknown', operator: 'contains', value: 'x' }]],
    [[{ field: 'subject', operator: 'contains', value: '' }]],
  ])('rejects invalid conditions: %o', async (conditions) => {
    const sql = createMockSql();
    const response = await createRule(sql, USER_ID, {
      action: 'apply_label',
      label_id: LABEL_ID,
      conditions,
    });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('returns 404 when the referenced label does not exist or is not user-owned', async () => {
    const sql = createMockSql([[]]);
    const response = await createRule(sql, USER_ID, {
      action: 'apply_label',
      label_id: LABEL_ID,
      conditions: CONDITIONS,
    });
    expect(response.status).toBe(404);
  });
});

describe('updateRule', () => {
  test('renames a rule', async () => {
    const sql = createMockSql([
      [
        {
          name: 'Old',
          label_id: LABEL_ID,
          action: 'apply_label',
          match_type: 'all',
          enabled: true,
        },
      ],
      [
        {
          id: RULE_ID,
          name: 'New',
          label_id: LABEL_ID,
          action: 'apply_label',
          match_type: 'all',
          enabled: true,
        },
      ],
      [],
    ]);
    const response = await updateRule(sql, USER_ID, { id: RULE_ID, name: 'New' });
    expect(response.status).toBe(200);
    expect((await response.json()).rule.name).toBe('New');
  });

  test('switching to mark_done clears any existing label', async () => {
    const sql = createMockSql([
      [
        {
          name: 'Rule',
          label_id: LABEL_ID,
          action: 'apply_label',
          match_type: 'all',
          enabled: true,
        },
      ],
      [
        {
          id: RULE_ID,
          name: 'Rule',
          label_id: null,
          action: 'mark_done',
          match_type: 'all',
          enabled: true,
        },
      ],
      [],
    ]);
    const response = await updateRule(sql, USER_ID, { id: RULE_ID, action: 'mark_done' });
    expect(response.status).toBe(200);
    expect((await response.json()).rule.label_id).toBeNull();
  });

  test('rejects mark_done combined with a label_id change', async () => {
    const sql = createMockSql([
      [{ name: 'Rule', label_id: null, action: 'mark_done', match_type: 'all', enabled: true }],
    ]);
    const response = await updateRule(sql, USER_ID, { id: RULE_ID, label_id: LABEL_ID });
    expect(response.status).toBe(400);
  });

  test('replaces conditions inside a transaction when conditions are included', async () => {
    const sql = createMockSql([
      [
        {
          name: 'Rule',
          label_id: LABEL_ID,
          action: 'apply_label',
          match_type: 'all',
          enabled: true,
        },
      ],
      [
        {
          id: RULE_ID,
          name: 'Rule',
          label_id: LABEL_ID,
          action: 'apply_label',
          match_type: 'all',
          enabled: true,
        },
      ],
    ]);
    const response = await updateRule(sql, USER_ID, { id: RULE_ID, conditions: CONDITIONS });
    expect(response.status).toBe(200);
    expect(sql.begin).toHaveBeenCalledOnce();
    const { rule } = await response.json();
    expect(rule.conditions).toEqual([{ ...CONDITIONS[0], position: 0 }]);
  });

  test('switching a conditions rule to AI stores the prompt and clears its conditions', async () => {
    const sql = createMockSql([
      [
        {
          name: 'Invoices',
          label_id: LABEL_ID,
          action: 'apply_label',
          kind: 'conditions',
          prompt: null,
          match_type: 'all',
          enabled: true,
        },
      ],
      [
        {
          id: RULE_ID,
          name: 'Invoices',
          label_id: LABEL_ID,
          action: 'apply_label',
          kind: 'ai',
          prompt: 'Invoices and bills',
          match_type: 'all',
          enabled: true,
        },
      ],
      [],
    ]);
    const response = await updateRule(sql, USER_ID, {
      id: RULE_ID,
      kind: 'ai',
      prompt: 'Invoices and bills',
    });
    expect(response.status).toBe(200);
    const { rule } = await response.json();
    expect(rule).toMatchObject({ kind: 'ai', prompt: 'Invoices and bills', conditions: [] });
    expect(sql.calls.some((call) => call.text.includes('DELETE FROM label_rule_conditions'))).toBe(
      true,
    );
    expect(sql.calls.some((call) => call.text.includes('INSERT INTO label_rule_conditions'))).toBe(
      false,
    );
  });

  test('switching an AI rule back to conditions requires conditions', async () => {
    const sql = createMockSql([
      [
        {
          name: 'Invoices',
          label_id: LABEL_ID,
          action: 'apply_label',
          kind: 'ai',
          prompt: 'Invoices and bills',
          match_type: 'all',
          enabled: true,
        },
      ],
    ]);
    const response = await updateRule(sql, USER_ID, { id: RULE_ID, kind: 'conditions' });
    expect(response.status).toBe(400);
    expect(sql.begin).not.toHaveBeenCalled();
  });

  test('returns 404 when the rule is not found or not user-owned', async () => {
    const sql = createMockSql([[]]);
    const response = await updateRule(sql, USER_ID, { id: RULE_ID, name: 'New' });
    expect(response.status).toBe(404);
  });

  test('rejects a missing id or no fields to update, without querying the database', async () => {
    const sql = createMockSql();
    expect((await updateRule(sql, USER_ID, { name: 'New' })).status).toBe(400);
    expect((await updateRule(sql, USER_ID, { id: RULE_ID })).status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('deleteRule', () => {
  test('deletes a user-owned rule', async () => {
    const sql = createMockSql([[{ id: RULE_ID }]]);
    const response = await deleteRule(sql, USER_ID, { id: RULE_ID });
    expect(response.status).toBe(200);
  });

  test('returns 404 when nothing was deleted', async () => {
    const sql = createMockSql([[]]);
    const response = await deleteRule(sql, USER_ID, { id: RULE_ID });
    expect(response.status).toBe(404);
  });
});
