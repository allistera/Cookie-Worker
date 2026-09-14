import { describe, expect, test } from 'vitest';
import {
  getContactInsights,
  normalizeContactAddress,
  patchContactInsights,
} from '../src/contactInsights.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-4999-8999-999999999999';
const MESSAGE_ID = '11111111-1111-1111-1111-111111111111';

describe('contact insights', () => {
  test('normalizes a valid address and rejects malformed input', () => {
    expect(normalizeContactAddress(' Alex@Example.com ')).toBe('alex@example.com');
    expect(normalizeContactAddress('not-an-address')).toBeNull();
  });

  test('returns private profile data and newest-first history', async () => {
    const sql = createMockSql([
      [
        {
          name: 'Alex',
          company: 'Example Studio',
          role: 'Director',
          linkedin_url: 'https://www.linkedin.com/in/alex',
          notes: 'Prefers email',
        },
      ],
      [
        {
          id: MESSAGE_ID,
          subject: 'Project proposal',
          snippet: 'Thanks for sending this',
          sent_at: '2026-09-14T09:00:00.000Z',
          is_sent: false,
        },
      ],
    ]);
    const response = await getContactInsights(
      sql,
      USER_ID,
      new URL('https://example.test/messages/contact-insights?address=Alex%40Example.com'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      contact: {
        address: 'alex@example.com',
        name: 'Alex',
        company: 'Example Studio',
        role: 'Director',
        linkedinUrl: 'https://www.linkedin.com/in/alex',
        notes: 'Prefers email',
      },
      history: [
        {
          id: MESSAGE_ID,
          subject: 'Project proposal',
          snippet: 'Thanks for sending this',
          sent_at: '2026-09-14T09:00:00.000Z',
          is_sent: false,
        },
      ],
      nextCursor: null,
    });
  });

  test('saves user-owned fields for the normalized address', async () => {
    const sql = createMockSql([
      [
        {
          company: 'Example Studio',
          role: 'Director',
          linkedin_url: 'https://linkedin.com/in/alex',
          notes: 'Private note',
        },
      ],
    ]);
    const response = await patchContactInsights(sql, USER_ID, {
      address: 'Alex@Example.com',
      company: ' Example Studio ',
      role: 'Director',
      linkedinUrl: 'https://linkedin.com/in/alex',
      notes: 'Private note',
    });

    expect(response.status).toBe(200);
    expect(sql.calls[0].values).toContain(USER_ID);
    expect(sql.calls[0].values).toContain('alex@example.com');
    expect((await response.json()).contact.notes).toBe('Private note');
  });

  test('rejects non-LinkedIn social URLs', async () => {
    const response = await patchContactInsights(createMockSql(), USER_ID, {
      address: 'alex@example.com',
      linkedinUrl: 'https://example.com/alex',
      notes: '',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Enter a valid LinkedIn URL');
  });
});
