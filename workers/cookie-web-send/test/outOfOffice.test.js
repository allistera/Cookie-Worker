import { describe, expect, test, vi } from 'vitest';
import {
  claimAutoReply,
  dispatchAutoReply,
  enqueueAutoReplies,
  flushOutOfOffice,
} from '../src/outOfOffice.js';
import { putOutOfOffice } from '../../cookie-web-emails/src/outOfOffice.js';
import {
  autoReplyDatabase,
  DELIVERY,
  FROM,
  MESSAGE,
  OWNER,
  SETTINGS,
} from './autoReplyDatabase.js';

const candidate = { id: DELIVERY, user_id: OWNER };
const services = (sendAutoReply) =>
  /** @type {any} */ ({ env: { EMAIL_FROM: FROM, RESEND_API_KEY: 'test' }, sendAutoReply });

describe('durable automatic reply delivery', () => {
  test('deduplicates repeated arrivals and waits for completed classification', async () => {
    const { sql, state } = autoReplyDatabase({ queued: false });
    state.messages.get(MESSAGE).ai_status = 'pending';
    expect(await enqueueAutoReplies(sql, FROM)).toBe(0);
    state.messages.get(MESSAGE).ai_status = 'completed';
    await Promise.all([enqueueAutoReplies(sql, FROM), enqueueAutoReplies(sql, FROM)]);
    expect(state.deliveries.size).toBe(1);
    expect(await enqueueAutoReplies(sql, FROM)).toBe(0);
  });
  test('concurrent claims reserve one logical send and one quota charge', async () => {
    const { sql, state } = autoReplyDatabase();
    const claims = await Promise.all([
      claimAutoReply(sql, candidate, FROM),
      claimAutoReply(sql, candidate, FROM),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(state.quota).toBe(1);
    expect(state.deliveries.get(DELIVERY).attempts).toBe(1);
    expect(state.queries[0]).toContain('pg_advisory_xact_lock');
    expect(state.queries.some((q) => q.includes('FOR UPDATE OF m, ai NOWAIT'))).toBe(true);
  });
  test('does not claim later deliveries after the shared background budget is consumed', async () => {
    const { sql, state, newDelivery } = autoReplyDatabase();
    const next = '55555555-5555-4555-8555-555555555555';
    state.deliveries.set(next, newDelivery(next, next));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const send = vi.fn(async (_payload, _key, _timeout) => {
      clock.mockReturnValue(20_000);
      return { status: 'sent', providerId: 'resend-1' };
    });
    try {
      await flushOutOfOffice(sql, services(send));
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][2]).toBe(10_000);
      expect(state.deliveries.get(next).attempts).toBe(0);
      expect(state.quota).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
  test('bounds the provider by remaining time and leaves an expired dispatch recoverable', async () => {
    const { sql, state } = autoReplyDatabase();
    const claimed = await claimAutoReply(sql, candidate, FROM);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(18_000);
    const send = vi.fn(async (_payload, _key, _timeout) => ({ status: 'retry', providerId: null }));
    try {
      await dispatchAutoReply(sql, claimed, services(send), 20_000);
      expect(send.mock.calls[0][2]).toBe(2_000);
      state.now = new Date(state.deliveries.get(DELIVERY).next_attempt_at);
      const retry = await claimAutoReply(sql, candidate, FROM);
      clock.mockReturnValue(20_000);
      expect(await dispatchAutoReply(sql, retry, services(send), 20_000)).toBe('deferred');
      expect(send).toHaveBeenCalledOnce();
      expect(state.deliveries.get(DELIVERY).status).toBe('sending');
    } finally {
      clock.mockRestore();
    }
  });
  test('uses the same persisted payload and key after an expired lease, without double charging quota', async () => {
    const { sql, state } = autoReplyDatabase();
    const first = await claimAutoReply(sql, candidate, FROM);
    state.failSentCommit = true;
    const send = vi.fn(async (_payload, _key) => ({ status: 'sent', providerId: 'resend-1' }));
    await expect(dispatchAutoReply(sql, first, services(send))).rejects.toThrow('simulated');
    expect(state.deliveries.get(DELIVERY).status).toBe('sending');
    state.failSentCommit = false;
    state.now = new Date(state.now.getTime() + 121_000);
    const retry = await claimAutoReply(sql, candidate, FROM);
    expect(await dispatchAutoReply(sql, retry, services(send))).toBe('sent');
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    expect(send.mock.calls[0][1]).toBe(`out-of-office/${DELIVERY}`);
    expect(state.quota).toBe(1);
  });
  test('never refunds a possibly consumed reservation on provider timeout', async () => {
    const { sql, state } = autoReplyDatabase();
    const first = await claimAutoReply(sql, candidate, FROM);
    expect(
      await dispatchAutoReply(
        sql,
        first,
        services(async () => ({ status: 'retry', providerId: null })),
      ),
    ).toBe('retried');
    expect(state.quota).toBe(1);
    state.now = new Date(state.deliveries.get(DELIVERY).next_attempt_at);
    const second = await claimAutoReply(sql, candidate, FROM);
    expect(second?.attempts).toBe(2);
    expect(state.quota).toBe(1);
    expect(state.queries.some((q) => q.includes('send_count - 1'))).toBe(false);
  });
  test('moves an ambiguous attempt to visible review before provider idempotency expires', async () => {
    const { sql, state } = autoReplyDatabase();
    await claimAutoReply(sql, candidate, FROM);
    state.now = new Date(state.deliveries.get(DELIVERY).retry_until);
    expect(await claimAutoReply(sql, candidate, FROM)).toBeNull();
    expect(state.deliveries.get(DELIVERY).status).toBe('uncertain');
    expect(state.senders.get(`${OWNER}/sender@example.com`).blocked).toBe(true);
  });
  test('enforces four days per normalized sender', async () => {
    const { sql, state, newDelivery } = autoReplyDatabase();
    const claimed = await claimAutoReply(sql, candidate, FROM);
    await dispatchAutoReply(
      sql,
      claimed,
      services(async () => ({ status: 'sent', providerId: 'resend-1' })),
    );
    const id = '55555555-5555-4555-8555-555555555555';
    state.messages.set(id, {
      ...state.messages.get(MESSAGE),
      id,
      created_at: state.now.toISOString(),
    });
    state.deliveries.set(id, newDelivery(id, id));
    expect(await claimAutoReply(sql, { id, user_id: OWNER }, FROM)).toBeNull();
    expect(state.deliveries.get(id).reason).toBe('sender_cooldown');
    state.now = new Date(state.now.getTime() + 4 * 86400_000);
    const later = '66666666-6666-4666-8666-666666666666';
    state.messages.set(later, {
      ...state.messages.get(MESSAGE),
      id: later,
      created_at: state.now.toISOString(),
    });
    state.deliveries.set(later, newDelivery(later, later));
    expect(await claimAutoReply(sql, { id: later, user_id: OWNER }, FROM)).not.toBeNull();
  });
  test('leaves quota-limited work unattempted for the next flush', async () => {
    const { sql, state } = autoReplyDatabase();
    state.quotaAvailable = false;
    expect(await claimAutoReply(sql, candidate, FROM)).toBeNull();
    expect(state.deliveries.get(DELIVERY).first_attempt_at).toBeNull();
    expect(state.senders.size).toBe(0);
  });

  test('does not release an unconfirmed sender just because four days passed before a recovery flush', async () => {
    const { sql, state, newDelivery } = autoReplyDatabase();
    await claimAutoReply(sql, candidate, FROM);
    state.now = new Date(state.now.getTime() + 5 * 86400_000);
    const id = '77777777-7777-4777-8777-777777777777';
    state.messages.set(id, {
      ...state.messages.get(MESSAGE),
      id,
      created_at: state.now.toISOString(),
    });
    state.deliveries.set(id, newDelivery(id, id));
    expect(await claimAutoReply(sql, { id, user_id: OWNER }, FROM)).toBeNull();
    expect(state.deliveries.get(id).reason).toBe('sender_cooldown');
    expect(state.quota).toBe(1);
  });
  test('rechecks disabling and screening between claim and provider dispatch', async () => {
    for (const suppress of [
      (state) => {
        state.users.get(OWNER).settings.enabled = false;
      },
      (state) => {
        state.messages.get(MESSAGE).auto_reply_suppressed = true;
      },
    ]) {
      const { sql, state } = autoReplyDatabase();
      const claimed = await claimAutoReply(sql, candidate, FROM);
      suppress(state);
      const send = vi.fn();
      expect(await dispatchAutoReply(sql, claimed, services(send))).toBe('uncertain');
      expect(send).not.toHaveBeenCalled();
    }
  });
  test('End now waits for an underway dispatch and prevents a later one', async () => {
    const { sql, state } = autoReplyDatabase();
    const claimed = await claimAutoReply(sql, candidate, FROM);
    let accepted;
    let started;
    const underway = new Promise((resolve) => {
      started = resolve;
    });
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          accepted = resolve;
          started();
        }),
    );
    const dispatch = dispatchAutoReply(sql, claimed, services(send));
    await underway;
    let stopped = false;
    const stop = putOutOfOffice(sql, OWNER, { action: 'stop' }).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    accepted({ status: 'sent', providerId: 'resend-1' });
    await dispatch;
    await stop;
    expect(state.users.get(OWNER).settings.enabled).toBe(false);
    expect(await dispatchAutoReply(sql, claimed, services(send))).toBe('skipped');
    expect(send).toHaveBeenCalledOnce();
  });
  test('an enabled edit cannot send old queued mail under the new text', async () => {
    const { sql, state } = autoReplyDatabase();
    await putOutOfOffice(sql, OWNER, { ...SETTINGS, text: 'Edited reply' });
    expect(await claimAutoReply(sql, candidate, FROM)).toBeNull();
    expect(state.deliveries.get(DELIVERY).status).toBe('suppressed');
    expect(state.deliveries.get(DELIVERY).payload.text).toBe(SETTINGS.text);
  });
});
