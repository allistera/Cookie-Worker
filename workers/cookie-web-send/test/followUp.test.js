import { describe, expect, it } from 'vitest';
import { handleFollowUp } from '../src/followUp.js';
import { createMockSql } from '../../cookie-web-tasks/test/helpers.js';
const ID = '11111111-1111-4111-8111-111111111111';
const request = (body) =>
  new Request('https://example.test/send/follow-up', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

describe('follow-up updates', () => {
  it('clears an owned sent reminder, with owner and sent checks in the write', async () => {
    const sql = createMockSql([[{ id: ID, followUpAt: null }]]);
    const response = await handleFollowUp(
      sql,
      'owner',
      request({ messageId: ID, followUpAt: null }),
    );
    expect(response.status).toBe(200);
    expect(sql.calls[0].text).toContain('m.user_id = ? AND m.is_sent AND NOT m.is_deleted');
    expect(sql.calls[0].values).toContain('owner');
  });
  it.each([
    [[], 404],
    [[{ exists: true }], 409],
  ])('distinguishes missing mail from a received reply', async (owned, status) => {
    const sql = createMockSql([[], owned]);
    const response = await handleFollowUp(
      sql,
      'owner',
      request({ messageId: ID, followUpAt: new Date(Date.now() + 3600000).toISOString() }),
    );
    expect(response.status).toBe(status);
    expect(sql.calls[0].text).toContain('NOT EXISTS');
  });
  it('rejects invalid dates before any database access', async () => {
    const sql = createMockSql([]);
    const response = await handleFollowUp(
      sql,
      'owner',
      request({ messageId: ID, followUpAt: 'invalid' }),
    );
    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });
});
