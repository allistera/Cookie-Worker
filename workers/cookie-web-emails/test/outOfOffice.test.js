import { describe, expect, test } from 'vitest';
import { getOutOfOffice, putOutOfOffice } from '../src/outOfOffice.js';
import {
  autoReplyDatabase,
  DELIVERY,
  OTHER,
  OWNER,
  SETTINGS,
} from '../../cookie-web-send/test/autoReplyDatabase.js';

describe('owner-scoped out-of-office API', () => {
  test('stopping an unconfigured responder remains off and retains the new revision', async () => {
    const { sql, state } = autoReplyDatabase();
    state.users.get(OWNER).settings = null;
    const response = await putOutOfOffice(sql, OWNER, { action: 'stop' });
    expect(await response.json()).toMatchObject({ enabled: false, revision: 1 });
  });

  test('keeps accounts separate and preserves unrelated preferences', async () => {
    const { sql, state } = autoReplyDatabase();
    const response = await putOutOfOffice(sql, OWNER, { ...SETTINGS, text: 'New reply' });
    expect(response.status).toBe(200);
    expect((await response.json()).revision).toBe(2);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(state.users.get(OWNER).theme).toBe('dark');
    const other = await (await getOutOfOffice(sql, OTHER)).json();
    expect(other.text).toBe(SETTINGS.text);
    expect(other.enabled).toBe(false);
  });
  test('conditional revision writes conflict instead of silently replacing a concurrent edit', async () => {
    const { sql } = autoReplyDatabase();
    const responses = await Promise.all([
      putOutOfOffice(sql, OWNER, { ...SETTINGS, text: 'First' }),
      putOutOfOffice(sql, OWNER, { ...SETTINGS, text: 'Second' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const conflict = /** @type {Response} */ (responses.find((r) => r.status === 409));
    expect((await conflict.json()).current.revision).toBe(2);
  });
  test('re-enabling records a fresh server activation time; stop always disables latest settings', async () => {
    const { sql, state } = autoReplyDatabase();
    await putOutOfOffice(sql, OWNER, { action: 'stop' });
    expect(state.users.get(OWNER).settings.enabled).toBe(false);
    state.now = new Date('2026-10-26T15:00:00Z');
    await putOutOfOffice(sql, OWNER, { ...SETTINGS, revision: 2, activatedAt: '2000-01-01' });
    expect(state.users.get(OWNER).settings.activatedAt).toBe(state.now.toISOString());
    expect(state.users.get(OWNER).settings.revision).toBe(3);
  });
  test('fails validation before writes and denies missing owners', async () => {
    const { sql, state } = autoReplyDatabase();
    expect((await putOutOfOffice(sql, OWNER, { ...SETTINGS, endDate: '2026-02-30' })).status).toBe(
      400,
    );
    expect(state.queries).toHaveLength(0);
    expect((await getOutOfOffice(sql, 'missing')).status).toBe(404);
  });
  test('only the owning user can review uncertain outcomes; resolution never enqueues or sends', async () => {
    const { sql, state } = autoReplyDatabase();
    state.deliveries.get(DELIVERY).status = 'uncertain';
    state.senders.set(`${OWNER}/sender@example.com`, {
      user_id: OWNER,
      sender: 'sender@example.com',
      delivery_id: DELIVERY,
      next_allowed_at: state.now.toISOString(),
      blocked: true,
    });
    expect((await (await getOutOfOffice(sql, OTHER)).json()).review).toHaveLength(0);
    expect((await (await getOutOfOffice(sql, OWNER)).json()).review).toHaveLength(1);
    expect(
      (
        await putOutOfOffice(sql, OTHER, {
          action: 'resolve',
          deliveryId: DELIVERY,
          outcome: 'not_delivered',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await putOutOfOffice(sql, OWNER, {
          action: 'resolve',
          deliveryId: DELIVERY,
          outcome: 'not_delivered',
        })
      ).status,
    ).toBe(200);
    expect(state.deliveries.get(DELIVERY).status).toBe('failed');
    expect(state.senders.get(`${OWNER}/sender@example.com`).blocked).toBe(false);
    expect((await (await getOutOfOffice(sql, OWNER)).json()).review).toHaveLength(0);
    expect(state.deliveries.size).toBe(1);
    expect(state.quota).toBe(0);
  });
});
