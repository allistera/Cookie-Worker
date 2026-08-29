import { describe, expect, it } from 'vitest';
import { isAncestorOf } from '../src/ancestry.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-9999-9999-999999999999';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

describe('isAncestorOf', () => {
  it('reports a cycle when the walk finds the moving row above the proposed parent', async () => {
    const sql = createMockSql([[{ ok: 1 }]]);

    const cycle = await isAncestorOf(sql, {
      table: 'task_projects',
      userId: USER_ID,
      id: ID_A,
      candidateParentId: ID_B,
    });

    expect(cycle).toBe(true);
  });

  it('reports no cycle when the walk reaches the root without finding it', async () => {
    const sql = createMockSql([[]]);

    const cycle = await isAncestorOf(sql, {
      table: 'task_items',
      userId: USER_ID,
      id: ID_A,
      candidateParentId: ID_B,
    });

    expect(cycle).toBe(false);
  });

  // The table name reaches SQL as an escaped identifier, never string
  // interpolation, so an attacker-supplied table can never be injected.
  it('passes the table through the driver as an identifier', async () => {
    const sql = createMockSql([[]]);

    await isAncestorOf(sql, {
      table: 'task_items',
      userId: USER_ID,
      id: ID_A,
      candidateParentId: ID_B,
    });

    expect(sql.calls.some((call) => call.text.includes('task_items'))).toBe(false);
    expect(sql.calls[0].text).toContain('WITH RECURSIVE ancestry');
  });
});
