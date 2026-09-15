import { describe, expect, test } from 'vitest';
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from '../src/categories.js';
import { createMockSql } from './helpers.js';

const CATEGORY_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '99999999-9999-4999-8999-999999999999';

describe('listCategories', () => {
  test("returns the user's categories with message counts", async () => {
    const category = {
      id: CATEGORY_ID,
      name: 'Projects',
      color: '#2F6BE0',
      description: 'Active work',
      notifications_enabled: true,
      message_count: 3,
    };
    const sql = createMockSql([[category]]);
    const response = await listCategories(sql, USER_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ categories: [category] });
    expect(sql.calls[0].text).toContain('m.category_id = c.id');
  });
});

describe('createCategory', () => {
  test('creates a category with normalized fields', async () => {
    const sql = createMockSql([
      [
        {
          id: CATEGORY_ID,
          name: 'Projects',
          color: '#2F6BE0',
          description: null,
          notifications_enabled: true,
        },
      ],
    ]);
    const response = await createCategory(sql, USER_ID, {
      name: '  Projects  ',
      color: '#2F6BE0',
      description: '  ',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      category: { name: 'Projects', description: null, notifications_enabled: true },
    });
    expect(sql.calls[0].text).toContain('notifications_enabled');
  });

  test.each([
    [{ color: '#2F6BE0' }],
    [{ name: 'x'.repeat(51), color: '#2F6BE0' }],
    [{ name: 'Projects', color: 'blue' }],
    [{ name: 'Projects', color: '#2F6BE0', description: 'x'.repeat(201) }],
  ])('rejects invalid input without querying the database: %o', async (body) => {
    const sql = createMockSql();
    const response = await createCategory(sql, USER_ID, body);
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('returns a conflict when the name already exists', async () => {
    const response = await createCategory(createMockSql([[]]), USER_ID, {
      name: 'Projects',
      color: '#2F6BE0',
    });
    expect(response.status).toBe(409);
  });
});

describe('updateCategory', () => {
  test('updates only an owned category', async () => {
    const category = { id: CATEGORY_ID, name: 'Clients', color: '#2F6BE0', description: null };
    const sql = createMockSql([[category]]);
    const response = await updateCategory(sql, USER_ID, {
      id: CATEGORY_ID,
      name: ' Clients ',
      description: '',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ category });
    expect(sql.calls[0].text).toContain('c.user_id =');
  });

  test('updates the notification preference with a boolean value', async () => {
    const category = {
      id: CATEGORY_ID,
      name: 'Clients',
      color: '#2F6BE0',
      description: null,
      notifications_enabled: false,
    };
    const sql = createMockSql([[category]]);

    const response = await updateCategory(sql, USER_ID, {
      id: CATEGORY_ID,
      notifications_enabled: false,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ category });
    expect(sql.calls[0].text).toContain('notifications_enabled');
    expect(sql.calls[0].values).toContain(false);
  });

  test.each([
    [{ id: CATEGORY_ID }],
    [{ id: 'invalid', name: 'Clients' }],
    [{ id: CATEGORY_ID, color: 'red' }],
    [{ id: CATEGORY_ID, notifications_enabled: 'false' }],
  ])('rejects invalid edits: %o', async (body) => {
    const sql = createMockSql();
    const response = await updateCategory(sql, USER_ID, body);
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('returns 404 for a missing or foreign category', async () => {
    const response = await updateCategory(createMockSql([[]]), USER_ID, {
      id: CATEGORY_ID,
      name: 'Clients',
    });
    expect(response.status).toBe(404);
  });
});

describe('deleteCategory', () => {
  test('deletes only an owned category', async () => {
    const sql = createMockSql([[{ id: CATEGORY_ID }]]);
    const response = await deleteCategory(sql, USER_ID, { id: CATEGORY_ID });
    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toContain('c.user_id =');
  });

  test('rejects malformed ids before querying', async () => {
    const sql = createMockSql();
    const response = await deleteCategory(sql, USER_ID, { id: 'invalid' });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});
