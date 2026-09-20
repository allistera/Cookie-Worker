import { describe, expect, it } from 'vitest';
import {
  createTaskLabel,
  deleteTaskLabel,
  getTaskLabels,
  updateTaskLabel,
} from '../src/taskLabels.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-9999-9999-999999999999';
const LABEL_ID = '11111111-1111-4111-8111-111111111111';
const LABEL = { id: LABEL_ID, name: 'home', color: '#1a73e8', taskCount: 2, createdAt: 't0' };

describe('GET /task-labels', () => {
  it('returns the caller labels with a task count each', async () => {
    const sql = createMockSql([[LABEL]]);

    const response = await getTaskLabels(sql, USER_ID);

    expect(response.status).toBe(200);
    expect((await response.json()).labels).toEqual([LABEL]);
    expect(sql.calls[0].text).toContain('FROM task_labels');
    expect(sql.calls[0].text).toContain('"taskCount"');
    expect(sql.calls[0].values).toContain(USER_ID);
  });
});

describe('POST /task-labels', () => {
  it('creates a label with the default colour', async () => {
    const sql = createMockSql([[{ ...LABEL, color: '#64748b', taskCount: 0 }]]);

    const response = await createTaskLabel(sql, USER_ID, { name: '@Home' });

    expect(response.status).toBe(201);
    expect((await response.json()).label.name).toBe('home');
    expect(sql.calls[0].text).toContain('INSERT INTO task_labels');
    expect(sql.calls[0].values).toEqual(expect.arrayContaining([USER_ID, 'home', '#64748b']));
  });

  it('stores a chosen colour', async () => {
    const sql = createMockSql([[{ ...LABEL, taskCount: 0 }]]);

    const response = await createTaskLabel(sql, USER_ID, { name: 'home', color: '#1A73E8' });

    expect(response.status).toBe(201);
    expect(sql.calls[0].values).toContain('#1a73e8');
  });

  it('rejects a bad name', async () => {
    const sql = createMockSql([]);
    const response = await createTaskLabel(sql, USER_ID, { name: 'two words' });
    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('rejects a colour that is not a hex triplet', async () => {
    const sql = createMockSql([]);
    const response = await createTaskLabel(sql, USER_ID, { name: 'home', color: 'blue' });
    expect(response.status).toBe(400);
  });

  // ON CONFLICT DO NOTHING returns no row when the name is taken.
  it('409s a name the caller already uses', async () => {
    const sql = createMockSql([[]]);
    const response = await createTaskLabel(sql, USER_ID, { name: 'home' });
    expect(response.status).toBe(409);
  });
});

describe('PATCH /task-labels', () => {
  it('renames a label and rewrites it on every task that carries it', async () => {
    const sql = createMockSql([
      [{ id: LABEL_ID, name: 'home' }], // the owned row
      [], // no other label has the new name
      [{ id: LABEL_ID, name: 'house', color: '#1a73e8', createdAt: 't0' }],
      [], // task rewrite
    ]);

    const response = await updateTaskLabel(sql, USER_ID, { id: LABEL_ID, name: '@House' });

    expect(response.status).toBe(200);
    expect((await response.json()).label.name).toBe('house');
    expect(sql.begin).toHaveBeenCalledTimes(1);
    const rewrite = sql.calls.find((call) => call.text.includes('array_replace'));
    expect(rewrite.text).toContain('UPDATE task_items');
    expect(rewrite.values).toEqual(expect.arrayContaining(['home', 'house', USER_ID]));
  });

  it('recolours without touching tasks', async () => {
    const sql = createMockSql([
      [{ id: LABEL_ID, name: 'home' }],
      [{ id: LABEL_ID, name: 'home', color: '#2f9e44', createdAt: 't0' }],
    ]);

    const response = await updateTaskLabel(sql, USER_ID, { id: LABEL_ID, color: '#2F9E44' });

    expect(response.status).toBe(200);
    expect((await response.json()).label.color).toBe('#2f9e44');
    expect(sql.calls.some((call) => call.text.includes('array_replace'))).toBe(false);
  });

  it('409s a rename onto a name already in use', async () => {
    const sql = createMockSql([[{ id: LABEL_ID, name: 'home' }], [{ id: 'other' }]]);
    const response = await updateTaskLabel(sql, USER_ID, { id: LABEL_ID, name: 'work' });
    expect(response.status).toBe(409);
  });

  it('404s an id the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await updateTaskLabel(sql, USER_ID, { id: LABEL_ID, name: 'x' });
    expect(response.status).toBe(404);
  });

  it('rejects an empty change and bad values', async () => {
    expect((await updateTaskLabel(createMockSql([]), USER_ID, { id: LABEL_ID })).status).toBe(400);
    expect(
      (await updateTaskLabel(createMockSql([]), USER_ID, { id: LABEL_ID, name: 'a b' })).status,
    ).toBe(400);
    expect(
      (await updateTaskLabel(createMockSql([]), USER_ID, { id: LABEL_ID, color: 'red' })).status,
    ).toBe(400);
    expect(
      (await updateTaskLabel(createMockSql([]), USER_ID, { id: 'nope', name: 'x' })).status,
    ).toBe(400);
  });
});

describe('DELETE /task-labels', () => {
  it('deletes the label and strips it from every task', async () => {
    const sql = createMockSql([[{ name: 'home' }], []]);

    const response = await deleteTaskLabel(sql, USER_ID, { id: LABEL_ID });

    expect(response.status).toBe(200);
    expect(sql.begin).toHaveBeenCalledTimes(1);
    const strip = sql.calls.find((call) => call.text.includes('array_remove'));
    expect(strip.text).toContain('UPDATE task_items');
    expect(strip.values).toEqual(expect.arrayContaining(['home', USER_ID]));
  });

  it('404s an id the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await deleteTaskLabel(sql, USER_ID, { id: LABEL_ID });
    expect(response.status).toBe(404);
  });
});
