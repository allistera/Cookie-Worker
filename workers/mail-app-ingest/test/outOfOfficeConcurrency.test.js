import { afterEach, describe, expect, test, vi } from 'vitest';
import worker from '../src/worker.js';
import { claimAutoReply, dispatchAutoReply } from '../../cookie-web-send/src/outOfOffice.js';
import { putOutOfOffice } from '../../cookie-web-emails/src/outOfOffice.js';
import { putSenders } from '../../cookie-web-emails/src/senders.js';
import { lockOutOfOfficeDispatch } from '../../../shared/outOfOffice.js';
import {
  DELIVERY,
  FROM,
  MESSAGE,
  OWNER,
  SETTINGS,
} from '../../cookie-web-send/test/autoReplyDatabase.js';
import { outOfOfficeConcurrencyDatabase } from './outOfOfficeConcurrencyDatabase.js';
import { fakeMessage, simpleFixture } from './helpers.js';

vi.mock('postgres', () => ({ default: vi.fn() }));
vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  withSentry: vi.fn((_options, handler) => handler),
}));
vi.mock('../../../shared/meiliSync.js', () => ({
  syncMessageToMeili: vi.fn(async () => undefined),
}));
const postgres = /** @type {any} */ ((await import('postgres')).default);
const REVIEW = '77777777-7777-4777-8777-777777777777';

afterEach(() => {
  vi.useRealTimers();
});

describe('responder dispatch does not borrow inbound storage locks', () => {
  test('a displayed-From block prevents dispatch and retains the committed claim for review', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    const { connect, state } = outOfOfficeConcurrencyDatabase();
    state.messages.get(MESSAGE).from_address = 'author@example.com';
    const claim = await claimAutoReply(connect(), { id: DELIVERY, user_id: OWNER }, FROM);
    expect(claim).toMatchObject({
      status: 'sending',
      attempts: 1,
      first_attempt_at: '2026-10-25T12:00:00.000Z',
      claim_token: expect.any(String),
    });
    await putSenders(connect(), OWNER, { action: 'block', address: 'author@example.com' });
    expect(state.senderDecisions.get(`${OWNER}/author@example.com`)).toBe('blocked');
    expect(state.messages.get(MESSAGE)).toMatchObject({ auto_reply_suppressed: true });
    const sendAutoReply = vi.fn();
    await dispatchAutoReply(
      connect(),
      claim,
      /** @type {any} */ ({ env: { EMAIL_FROM: FROM }, sendAutoReply }),
    );
    expect(sendAutoReply).not.toHaveBeenCalled();
    expect(state.deliveries.get(DELIVERY)).toMatchObject({
      // The durable claim precedes provider I/O and can survive a crash. Once
      // claimed, screening must retain conservative uncertainty for review.
      status: 'uncertain',
      reason: 'screened',
      claimed_at: null,
      claim_token: null,
    });
    expect([...state.senders.values()]).toContainEqual(
      expect.objectContaining({ user_id: OWNER, delivery_id: DELIVERY, blocked: true }),
    );
  });

  test.each(['stop', 'save', 'resolve', 'claim', 'screen', 'sender-block', 'screening-settings'])(
    'stores and forwards within the unchanged budget while a slow provider and %s wait',
    async (contender) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const { connect, state, newDelivery } = outOfOfficeConcurrencyDatabase();
      const sql = connect();
      postgres.mockReturnValue(connect());
      const review = newDelivery(REVIEW, REVIEW);
      review.status = contender === 'claim' ? 'pending' : 'failed';
      state.deliveries.set(REVIEW, review);
      state.messages.set(REVIEW, {
        ...state.messages.get(MESSAGE),
        id: REVIEW,
        message_id: '<review@example.com>',
      });
      const candidate = { id: DELIVERY, user_id: OWNER };
      const claimed = await claimAutoReply(sql, candidate, FROM);
      let releaseProvider;
      let started;
      let providerPending = true;
      const underway = new Promise((resolve) => {
        started = resolve;
      });
      const services = /** @type {any} */ ({
        env: { EMAIL_FROM: FROM },
        sendAutoReply: () =>
          new Promise((resolve) => {
            releaseProvider = () => {
              providerPending = false;
              resolve({ status: 'sent', providerId: 'confirmed' });
            };
            started();
          }),
      });
      const dispatch = dispatchAutoReply(sql, claimed, services);
      await underway;
      let contenderComplete = false;
      const waiting = (
        contender === 'claim'
          ? claimAutoReply(connect(), { id: REVIEW, user_id: OWNER }, FROM)
          : contender === 'sender-block' || contender === 'screening-settings'
            ? putSenders(
                connect(),
                OWNER,
                contender === 'sender-block'
                  ? { action: 'block', address: 'sender@example.com', messageId: MESSAGE }
                  : { action: 'settings', enabled: true },
              )
            : contender === 'screen'
              ? connect().begin(async (tx) => {
                  await lockOutOfOfficeDispatch(tx, OWNER);
                  await tx`UPDATE messages SET auto_reply_suppressed = true WHERE id = ${MESSAGE} AND user_id = ${OWNER}`;
                })
              : putOutOfOffice(
                  connect(),
                  OWNER,
                  contender === 'stop'
                    ? { action: 'stop' }
                    : contender === 'save'
                      ? { ...SETTINGS, text: 'New reviewed reply' }
                      : { action: 'resolve', deliveryId: REVIEW, outcome: 'not_delivered' },
                )
      ).then((result) => {
        contenderComplete = true;
        return result;
      });
      const pending = [];
      const ctx = /** @type {any} */ ({ waitUntil: (promise) => pending.push(promise) });
      const env = /** @type {any} */ ({
        HYPERDRIVE: { connectionString: 'postgres://test' },
        OWNER_EMAIL: 'owner@example.com',
        FORWARD_TO: 'forward@example.com',
      });
      const message = fakeMessage(simpleFixture);
      let ingestResult;
      const ingest = worker.email(message, env, ctx).then(
        () => {
          ingestResult = 'forwarded';
        },
        () => {
          ingestResult = 'rejected';
        },
      );
      try {
        // The provider is still unresolved beyond ingest's five-second limit.
        // Real ingest parsing/storage/forwarding runs against concurrent locks.
        await vi.advanceTimersByTimeAsync(6_000);
        expect(providerPending).toBe(true);
        expect(contenderComplete).toBe(false);
        expect(ingestResult).toBe('forwarded');
        expect(message.forward).toHaveBeenCalledExactlyOnceWith('forward@example.com');
        expect(message.setReject).not.toHaveBeenCalled();
        const stored = [...state.messages.values()].find(
          (row) => row.message_id === '<simple@example.com>',
        );
        expect(stored).toMatchObject({ out_of_office_revision: 1, ai_status: 'pending' });
      } finally {
        releaseProvider();
        await Promise.all([dispatch, waiting, ingest]);
        await Promise.all(pending);
      }
      expect(contenderComplete).toBe(true);
      const later = fakeMessage(
        simpleFixture.replace('<simple@example.com>', '<later@example.com>'),
      );
      await worker.email(later, env, ctx);
      expect(later.forward).toHaveBeenCalledOnce();
      const storedLater = [...state.messages.values()].find(
        (row) => row.message_id === '<later@example.com>',
      );
      expect(storedLater.out_of_office_revision).toBe(
        contender === 'stop' ? null : contender === 'save' ? 2 : 1,
      );
      expect(storedLater.screening_status).toBe(
        contender === 'screening-settings' ? 'held' : 'allowed',
      );
      await Promise.all(pending);
    },
  );
});
