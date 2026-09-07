import { expect, test, vi } from 'vitest';
import { applyAutoArchive } from '../src/autoArchive.js';

test('rechecks disabled preferences and never archives after opt-out', async () => {
  const tx = vi.fn().mockResolvedValue([{ settings: { marketing: { enabled: false } } }]);
  await applyAutoArchive(/** @type {any} */ (tx), 'user-1', 'message-1', 'marketing');
  expect(tx).toHaveBeenCalledTimes(1);
});

test.each([true, false])(
  'only discards queued notifications when a message was archived (%s)',
  async (changed) => {
    const tx = vi
      .fn()
      .mockResolvedValueOnce([
        { settings: { marketing: { enabled: true, since: '2026-09-07T00:00:00Z' } } },
      ])
      .mockResolvedValueOnce(changed ? [{ id: 'message-1' }] : [])
      .mockResolvedValue([]);
    await applyAutoArchive(/** @type {any} */ (tx), 'user-1', 'message-1', 'marketing');
    const query = tx.mock.calls[1][0].join('?');
    expect(query).toContain('user_id = ? AND created_at >= ?::timestamptz');
    expect(query).toContain(
      'AND is_unread AND NOT is_starred AND NOT is_sent AND NOT is_deleted AND NOT is_archived',
    );
    expect(query).toContain('AND scheduled_for IS NULL');
    expect(tx).toHaveBeenCalledTimes(changed ? 3 : 2);
    if (changed)
      expect(tx.mock.calls[2][0].join('?')).toContain('DELETE FROM browser_notification_events');
  },
);
