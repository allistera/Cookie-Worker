import { describe, expect, test } from 'vitest';
import { ToolInputError } from '../src/results.js';
import { tools } from '../src/tools/organise.js';
import { byName, fakeApi } from './helpers.js';

const ID = '11111111-1111-4111-8111-111111111111';
const L1 = '22222222-2222-4222-8222-222222222222';
const L2 = '33333333-3333-4333-8333-333333333333';
const L3 = '44444444-4444-4444-8444-444444444444';

/** @param {string} name @param {any} args @param {any} api */
async function call(name, args, api) {
  const tool = byName(tools, name);
  const result = await tool.run(tool.inputSchema.parse(args), api);
  tool.outputSchema.parse(result);
  return result;
}

const labelRow = {
  id: L1,
  name: 'Work',
  color: '#112233',
  kind: 'user',
  description: null,
  auto_apply: false,
};

describe('organise tools', () => {
  test('cookie_update_message patches only the provided flags with real booleans', async () => {
    const api = fakeApi();
    api.messages.patch.mockResolvedValue({ message: { id: ID, is_starred: true } });
    const result = await call('cookie_update_message', { id: ID, starred: true, done: false }, api);
    expect(api.messages.patch).toHaveBeenCalledWith('/messages', {
      id: ID,
      is_starred: true,
      is_archived: false,
    });
    expect(api.messages.post).not.toHaveBeenCalled();
    expect(result).toEqual({ message: { id: ID, is_starred: true } });
  });

  test('cookie_update_message maps every flag and snooze', async () => {
    const api = fakeApi();
    api.messages.patch.mockResolvedValue({});
    const until = '2026-10-05T09:00:00Z';
    const result = await call(
      'cookie_update_message',
      { id: ID, unread: true, trashed: true, spam: false, snoozeUntil: until },
      api,
    );
    expect(api.messages.patch).toHaveBeenCalledWith('/messages', {
      id: ID,
      is_unread: true,
      is_deleted: true,
      is_spam: false,
      scheduled_for: until,
    });
    expect(result).toEqual({ message: { id: ID } });
  });

  test('cookie_update_message sends scheduled_for null to clear a snooze', async () => {
    const api = fakeApi();
    api.messages.patch.mockResolvedValue({ message: { id: ID } });
    await call('cookie_update_message', { id: ID, snoozeUntil: null }, api);
    expect(api.messages.patch).toHaveBeenCalledWith('/messages', { id: ID, scheduled_for: null });
  });

  test('cookie_update_message omits the patch when only labels change and sends them in one request', async () => {
    const api = fakeApi();
    api.messages.post.mockResolvedValueOnce({ labels: [] });
    const result = await call(
      'cookie_update_message',
      { id: ID, addLabelIds: [L1, L2], removeLabelIds: [L3] },
      api,
    );
    expect(api.messages.patch).not.toHaveBeenCalled();
    expect(api.messages.post.mock.calls).toEqual([
      [
        '/messages',
        { id: ID, action: 'update_labels', add_label_ids: [L1, L2], remove_label_ids: [L3] },
      ],
    ]);
    expect(result).toEqual({ message: { id: ID }, labels: [] });
  });

  test('cookie_update_message patches before running label actions', async () => {
    const api = fakeApi();
    const order = /** @type {string[]} */ ([]);
    api.messages.patch.mockImplementation(async () => {
      order.push('patch');
      return { message: { id: ID } };
    });
    api.messages.post.mockImplementation(async () => {
      order.push('post');
      return { labels: [] };
    });
    await call('cookie_update_message', { id: ID, done: true, addLabelIds: [L1] }, api);
    expect(order).toEqual(['patch', 'post']);
  });

  test('cookie_update_message rejects an empty change', async () => {
    const api = fakeApi();
    await expect(call('cookie_update_message', { id: ID }, api)).rejects.toThrow(ToolInputError);
    await expect(
      call('cookie_update_message', { id: ID, addLabelIds: [], removeLabelIds: [] }, api),
    ).rejects.toThrow('Give at least one change');
    expect(api.messages.patch).not.toHaveBeenCalled();
    expect(api.messages.post).not.toHaveBeenCalled();
  });

  test('cookie_update_message validates input', () => {
    const { inputSchema } = byName(tools, 'cookie_update_message');
    expect(() => inputSchema.parse({ id: 'nope', done: true })).toThrow();
    expect(() => inputSchema.parse({ id: ID, snoozeUntil: 'tomorrow' })).toThrow();
    expect(() => inputSchema.parse({ id: ID, addLabelIds: Array(21).fill(L1) })).toThrow();
  });

  test('cookie_list_labels maps rows', async () => {
    const api = fakeApi();
    api.labels.get.mockResolvedValue({ labels: [{ ...labelRow, message_count: 4 }] });
    const result = await call('cookie_list_labels', {}, api);
    expect(api.labels.get).toHaveBeenCalledWith('/labels');
    expect(result).toEqual({
      labels: [
        {
          id: L1,
          name: 'Work',
          color: '#112233',
          kind: 'user',
          description: null,
          autoApply: false,
          messageCount: 4,
        },
      ],
    });
  });

  test('cookie_create_label defaults the colour and returns the label', async () => {
    const api = fakeApi();
    api.labels.post.mockResolvedValue({ label: { ...labelRow, message_count: 0 } });
    const result = await call('cookie_create_label', { name: 'Work' }, api);
    expect(api.labels.post).toHaveBeenCalledWith('/labels', {
      name: 'Work',
      color: '#6b7280',
      description: undefined,
    });
    expect(result).toEqual({ label: { ...labelRow, message_count: 0 } });
  });

  test('cookie_create_label rejects bad colours', () => {
    const { inputSchema } = byName(tools, 'cookie_create_label');
    expect(() => inputSchema.parse({ name: 'x', color: 'red' })).toThrow();
    expect(() => inputSchema.parse({ name: '' })).toThrow();
  });

  test('cookie_update_label sends only provided keys', async () => {
    const api = fakeApi();
    api.labels.patch.mockResolvedValue({ label: labelRow });
    const result = await call('cookie_update_label', { id: L1, autoApply: false }, api);
    expect(api.labels.patch).toHaveBeenCalledWith('/labels', { id: L1, auto_apply: false });
    expect(result).toEqual({ label: labelRow });
  });

  test('cookie_update_label rejects when nothing changes', async () => {
    const api = fakeApi();
    await expect(call('cookie_update_label', { id: L1 }, api)).rejects.toThrow(ToolInputError);
    expect(api.labels.patch).not.toHaveBeenCalled();
  });

  test('cookie_delete_label deletes by id', async () => {
    const api = fakeApi();
    api.labels.delete.mockResolvedValue({ ok: true });
    const result = await call('cookie_delete_label', { id: L1 }, api);
    expect(api.labels.delete).toHaveBeenCalledWith('/labels', { id: L1 });
    expect(result).toEqual({ deleted: true, id: L1 });
    expect(byName(tools, 'cookie_delete_label').annotations.destructiveHint).toBe(true);
  });
});
