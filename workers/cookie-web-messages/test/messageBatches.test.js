import { describe, expect, test, vi } from 'vitest';
import { patchMessage, postMessage } from '../src/messages.js';
import { createMockSql } from './helpers.js';

const id = '11111111-1111-4111-8111-111111111111';
const label = '22222222-2222-4222-8222-222222222222';
const deps = () => ({
  requestPublicHttps: vi.fn(),
  resendApiKey: undefined,
  emailFrom: undefined,
  sendEmail: vi.fn(),
  onMessagesChanged: vi.fn(),
});

describe('bulk message changes', () => {
  test.each([
    { ids: [] },
    { ids: ['invalid'] },
    { ids: [id] },
    { ids: [id], is_unread: 'yes' },
    { ids: [id], is_spam: true },
    { ids: [id], category_id: 'invalid' },
    { ids: [id], scheduled_for: 'invalid' },
    {
      ids: Array.from(
        { length: 101 },
        (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
      ),
      is_unread: true,
    },
  ])('rejects invalid changes before database access: %j', async (body) => {
    const sql = createMockSql();
    const response = await patchMessage(sql, 'owner', body);
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  test('deduplicates IDs and reindexes only returned changed messages', async () => {
    const sql = createMockSql([[{ id }]]);
    const hooks = deps();
    const response = await patchMessage(
      sql,
      'owner',
      {
        ids: [id, id],
        is_unread: false,
        is_starred: true,
        is_archived: true,
        is_deleted: false,
        scheduled_for: null,
      },
      hooks,
    );
    expect(await response.json()).toEqual({ updated: 1, ids: [id] });
    expect(sql.calls[0].values).toContainEqual([id]);
    expect(sql.calls[0].values).toContain('owner');
    expect(hooks.onMessagesChanged).toHaveBeenCalledWith([id]);
  });

  test.each([null, label])(
    'changes category %s without requesting a search reindex',
    async (category) => {
      const sql = createMockSql(category ? [[{ id: label }], [{ id }]] : [[{ id }]]);
      const hooks = deps();
      const response = await patchMessage(
        sql,
        'owner',
        { ids: [id], category_id: category },
        hooks,
      );
      expect(await response.json()).toEqual({ updated: 1, ids: [id] });
      expect(hooks.onMessagesChanged).not.toHaveBeenCalled();
    },
  );

  test('rejects an unowned category without updating messages', async () => {
    const sql = createMockSql([[]]);
    const response = await patchMessage(sql, 'owner', { ids: [id], category_id: label });
    expect(response.status).toBe(404);
    expect(sql).toHaveBeenCalledOnce();
  });

  test('does not notify when a scheduled change matches no owned messages', async () => {
    const hooks = deps();
    const response = await patchMessage(
      createMockSql([[]]),
      'owner',
      { ids: [id], scheduled_for: '2030-01-01T12:00:00Z' },
      hooks,
    );
    expect(await response.json()).toEqual({ updated: 0, ids: [] });
    expect(hooks.onMessagesChanged).not.toHaveBeenCalled();
  });
});

describe('bulk label changes', () => {
  test.each(['add_label', 'remove_label'])(
    'applies %s transactionally and reindexes changed messages',
    async (action) => {
      const sql = createMockSql([[{ id: label }], [{ message_id: id }], []]);
      const hooks = deps();
      const response = await postMessage(
        sql,
        'owner',
        { action, ids: [id, id], label_id: label },
        hooks,
      );
      expect(await response.json()).toEqual({ updated: 1, ids: [id] });
      expect(sql.begin).toHaveBeenCalledOnce();
      expect(sql.calls[1].values).toContainEqual([id]);
      expect(sql.calls[2].text).toContain('search_indexed_at = NULL');
      expect(hooks.onMessagesChanged).toHaveBeenCalledWith([id]);
    },
  );

  test('rejects missing labels before mutation', async () => {
    const sql = createMockSql([[]]);
    const response = await postMessage(
      sql,
      'owner',
      { action: 'add_label', ids: [id], label_id: label },
      deps(),
    );
    expect(response.status).toBe(404);
    expect(sql).toHaveBeenCalledOnce();
  });

  test('does not dirty the search index for an unchanged label assignment', async () => {
    const sql = createMockSql([[{ id: label }], []]);
    const hooks = deps();
    const response = await postMessage(
      sql,
      'owner',
      { action: 'add_label', ids: [id], label_id: label },
      hooks,
    );
    expect(await response.json()).toEqual({ updated: 0, ids: [] });
    expect(sql).toHaveBeenCalledTimes(2);
    expect(hooks.onMessagesChanged).not.toHaveBeenCalled();
  });

  test.each([
    { ids: [], label_id: label },
    { ids: ['invalid'], label_id: label },
    { ids: [id], label_id: 'invalid' },
  ])('validates a label batch %j', async (body) => {
    const sql = createMockSql();
    const response = await postMessage(sql, 'owner', { action: 'add_label', ...body }, deps());
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
});
