import { describe, expect, test } from 'vitest';
import { getContacts } from '../src/contacts.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-4999-8999-999999999999';

describe('getContacts', () => {
  test('returns address/name pairs with a private cache header', async () => {
    const sql = createMockSql([[{ address: 'a@example.com', name: 'Ada' }]]);
    const response = await getContacts(sql, USER_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(await response.json()).toEqual({
      contacts: [{ address: 'a@example.com', name: 'Ada' }],
    });
  });

  test('returns an empty list when the user has no contacts', async () => {
    const sql = createMockSql([[]]);
    const response = await getContacts(sql, USER_ID);
    expect(await response.json()).toEqual({ contacts: [] });
  });
});
