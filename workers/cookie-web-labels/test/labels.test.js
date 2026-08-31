import { describe, expect, test } from 'vitest';
import { createLabel, deleteLabel, listLabels, updateLabel } from '../src/labels.js';
import { createMockSql } from './helpers.js';

const LABEL_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '99999999-9999-4999-8999-999999999999';

describe('listLabels', () => {
  test("returns the user's labels with message counts", async () => {
    const sql = createMockSql([
      [{ id: LABEL_ID, name: 'Work', color: '#2F6BE0', message_count: 3 }],
    ]);
    const response = await listLabels(sql, USER_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      labels: [{ id: LABEL_ID, name: 'Work', color: '#2F6BE0', message_count: 3 }],
    });
  });
});

describe('createLabel', () => {
  test('creates a label with a trimmed name and hex color', async () => {
    const sql = createMockSql([
      [{ id: LABEL_ID, name: 'Work', color: '#2F6BE0', kind: 'user', message_count: 0 }],
    ]);
    const response = await createLabel(sql, USER_ID, { name: '  Work  ', color: '#2F6BE0' });
    expect(response.status).toBe(201);
    expect((await response.json()).label.name).toBe('Work');
  });

  test.each([
    [{ color: '#2F6BE0' }, 'missing name'],
    [{ name: 'x'.repeat(51), color: '#2F6BE0' }, 'name too long'],
    [{ name: 'Work', color: 'blue' }, 'invalid color'],
    [{ name: 'Work', color: '#2F6BE0', description: 'x'.repeat(201) }, 'description too long'],
  ])('rejects invalid input without querying the database: %s', async (body, _label) => {
    const sql = createMockSql();
    const response = await createLabel(sql, USER_ID, body);
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('returns a conflict when the name already exists', async () => {
    const sql = createMockSql([[]]);
    const response = await createLabel(sql, USER_ID, { name: 'Work', color: '#2F6BE0' });
    expect(response.status).toBe(409);
  });
});

describe('updateLabel', () => {
  test('renames a label and marks its messages for reindexing', async () => {
    const sql = createMockSql([
      [{ id: LABEL_ID, name: 'Money', color: '#2f9e44', kind: 'user', auto_apply: true }],
      [],
    ]);
    const response = await updateLabel(sql, USER_ID, { id: LABEL_ID, name: '  Money  ' });
    expect(response.status).toBe(200);
    expect((await response.json()).label.name).toBe('Money');
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[0].text).toMatch(/UPDATE labels/);
    expect(sql.calls[1].text).toMatch(/UPDATE messages SET search_indexed_at = NULL/);
    expect(sql.calls[1].text).toMatch(/message_labels/);
  });

  test('updates color and description, including clearing the description, without marking messages', async () => {
    const sql = createMockSql([
      [
        {
          id: LABEL_ID,
          name: 'Work',
          color: '#2F6BE0',
          kind: 'user',
          description: null,
          auto_apply: false,
        },
      ],
    ]);
    const response = await updateLabel(sql, USER_ID, {
      id: LABEL_ID,
      color: '#2F6BE0',
      description: '',
      auto_apply: false,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ label: { color: '#2F6BE0', description: null } });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).not.toMatch(/search_indexed_at/);
  });

  test.each([
    [{ id: LABEL_ID, color: 'blue' }],
    [{ id: LABEL_ID, color: '#12345' }],
    [{ id: LABEL_ID, description: 'x'.repeat(201) }],
    [{ id: 'not-a-uuid', name: 'Work' }],
    [{ id: LABEL_ID }],
  ])('rejects invalid edits without querying the database: %o', async (body) => {
    const sql = createMockSql();
    const response = await updateLabel(sql, USER_ID, body);
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('returns a conflict when the rename collides with an existing label', async () => {
    const sql = createMockSql();
    sql.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('duplicate'), { code: '23505' })),
    );
    const response = await updateLabel(sql, USER_ID, { id: LABEL_ID, name: 'Home' });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already exists/i);
  });

  test('returns 404 when the label is not found or not user-owned', async () => {
    const sql = createMockSql([[]]);
    const response = await updateLabel(sql, USER_ID, { id: LABEL_ID, name: 'Home' });
    expect(response.status).toBe(404);
  });
});

describe('deleteLabel', () => {
  test("marks the label's messages for reindexing before deleting it", async () => {
    const sql = createMockSql([[], [{ id: LABEL_ID }]]);
    const response = await deleteLabel(sql, USER_ID, { id: LABEL_ID });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[0].text).toMatch(/UPDATE messages SET search_indexed_at = NULL/);
    expect(sql.calls[0].text).toMatch(/message_labels/);
    expect(sql.calls[1].text).toMatch(/DELETE FROM labels/);
  });

  test('returns 404 when nothing was deleted', async () => {
    const sql = createMockSql([[], []]);
    const response = await deleteLabel(sql, USER_ID, { id: LABEL_ID });
    expect(response.status).toBe(404);
  });

  test('rejects a missing id without querying the database', async () => {
    const sql = createMockSql();
    const response = await deleteLabel(sql, USER_ID, {});
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});
