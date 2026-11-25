import { describe, expect, test, vi } from 'vitest';
import { getSubscriptions, recordUnsubscribe } from '../src/subscriptions.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-4999-8999-999999999999';
const MESSAGE_ID = '11111111-1111-1111-1111-111111111111';

/** @param {Record<string, unknown>} [overrides] */
function senderRow(overrides = {}) {
  return {
    id: MESSAGE_ID,
    from_name: 'Daily Bites',
    address: 'news@dailybites.example',
    message_count: 12,
    sent_at: '2026-11-20T08:00:00.000Z',
    list_headers: [
      { key: 'List-Unsubscribe', value: '<https://dailybites.example/unsubscribe?u=1>' },
      { key: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    ],
    ...overrides,
  };
}

describe('getSubscriptions', () => {
  test('lists each sender with the message to unsubscribe through', async () => {
    const sql = createMockSql([[senderRow()], []]);
    const response = await getSubscriptions(sql, USER_ID);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      subscriptions: [
        {
          address: 'news@dailybites.example',
          name: 'Daily Bites',
          messageId: MESSAGE_ID,
          messageCount: 12,
          lastReceivedAt: '2026-11-20T08:00:00.000Z',
          unsubscribedAt: null,
        },
      ],
    });
    expect(sql.calls[0].values).toEqual([USER_ID, 1000]);
    expect(sql.calls[1].values).toEqual([USER_ID]);
  });

  test('never returns the sender-controlled headers', async () => {
    const sql = createMockSql([[senderRow()], []]);
    const body = await (await getSubscriptions(sql, USER_ID)).text();
    expect(body).not.toContain('unsubscribe?u=1');
    expect(body).not.toContain('list_headers');
  });

  test('reports when the person unsubscribed from a sender', async () => {
    const sql = createMockSql([
      [senderRow(), senderRow({ address: 'other@example.com', from_name: null })],
      [{ address: 'news@dailybites.example', unsubscribed_at: '2026-11-21T09:30:00.000Z' }],
    ]);
    const { subscriptions } = await (await getSubscriptions(sql, USER_ID)).json();

    expect(subscriptions.map((/** @type {any} */ entry) => entry.unsubscribedAt)).toEqual([
      '2026-11-21T09:30:00.000Z',
      null,
    ]);
    expect(subscriptions[1].name).toBeNull();
  });

  test('leaves out senders that offer nothing the unsubscribe action can use', async () => {
    const sql = createMockSql([
      [
        senderRow({
          address: 'mailto@example.com',
          list_headers: [{ key: 'list-unsubscribe', value: '<mailto:leave@example.com>' }],
        }),
        senderRow({
          address: 'plain-http@example.com',
          list_headers: [{ key: 'List-Unsubscribe', value: '<http://example.com/leave>' }],
        }),
        senderRow({
          address: 'internal@example.com',
          list_headers: [{ key: 'List-Unsubscribe', value: '<https://intranet.local/leave>' }],
        }),
        senderRow({
          address: 'malformed@example.com',
          list_headers: [{ key: 'List-Unsubscribe', value: 'not a uri' }],
        }),
        senderRow({ address: 'missing@example.com', list_headers: null }),
      ],
      [],
    ]);
    const { subscriptions } = await (await getSubscriptions(sql, USER_ID)).json();

    expect(subscriptions.map((/** @type {any} */ entry) => entry.address)).toEqual([
      'mailto@example.com',
    ]);
  });

  test('lists senders before the unsubscribe table exists', async () => {
    const sql = createMockSql([[senderRow()]]);
    sql
      .mockImplementationOnce(sql.getMockImplementation())
      .mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' })),
      );
    const { subscriptions } = await (await getSubscriptions(sql, USER_ID)).json();

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].unsubscribedAt).toBeNull();
  });

  test('passes on any other failure to read the unsubscribe table', async () => {
    const sql = createMockSql([[senderRow()]]);
    sql
      .mockImplementationOnce(sql.getMockImplementation())
      .mockImplementationOnce(() => Promise.reject(new Error('connection lost')));

    await expect(getSubscriptions(sql, USER_ID)).rejects.toThrow('connection lost');
  });
});

describe('recordUnsubscribe', () => {
  test('upserts the sender for the owner', async () => {
    const sql = createMockSql();
    await recordUnsubscribe(sql, USER_ID, 'news@dailybites.example', 'ai');

    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain('ON CONFLICT (user_id, address) DO UPDATE');
    expect(sql.calls[0].values).toEqual([USER_ID, 'news@dailybites.example', 'ai']);
  });

  test('writes nothing without a sender address', async () => {
    const sql = createMockSql();
    await recordUnsubscribe(sql, USER_ID, '', 'mailto');
    expect(sql).not.toHaveBeenCalled();
  });

  test('swallows a failed write', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sql = vi.fn(() => Promise.reject(new Error('table missing')));
    await expect(
      recordUnsubscribe(/** @type {any} */ (sql), USER_ID, 'news@dailybites.example', 'one-click'),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unsubscribe_record_failed'));
    log.mockRestore();
  });
});
