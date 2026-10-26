import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSendServices } from '../src/worker.js';
import { claimAutoReply, dispatchAutoReply } from '../src/outOfOffice.js';
import { autoReplyDatabase, DELIVERY, FROM, OWNER } from './autoReplyDatabase.js';

// Only fetch is stubbed. It never answers, so each call ends when the adapter's
// own timer aborts it, which is what decides the budget under test.
function stallingFetch() {
  return vi.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  );
}

/** Lets fake time advance and every promise chain that follows it settle. */
async function elapse(ms) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('provider budgets through the production send wiring', () => {
  test('a user send waits 20 seconds for the provider before giving up', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', stallingFetch());
    const services = /** @type {any} */ (
      createSendServices(
        /** @type {any} */ ({ RESEND_API_KEY: 'test' }),
        /** @type {any} */ ({ waitUntil: () => undefined }),
      )
    );

    /** @type {string | null} */
    let outcome = null;
    const send = services
      .sendProvider({ from: FROM, to: ['sender@example.com'], subject: 'Hi', text: 'Hello' }, 'k')
      .then((/** @type {{status: string}} */ value) => {
        outcome = value.status;
      });
    await elapse(0);
    await elapse(19_999);
    expect(outcome).toBeNull();
    await elapse(1);
    expect(outcome).toBe('retry');
    await send;
  });

  test('an automatic reply keeps the 10-second budget', async () => {
    vi.useFakeTimers();
    const fetchMock = stallingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { sql } = autoReplyDatabase();
    const claimed = await claimAutoReply(sql, { id: DELIVERY, user_id: OWNER }, FROM);

    /** @type {string | null} */
    let outcome = null;
    const dispatch = dispatchAutoReply(
      sql,
      claimed,
      /** @type {any} */ ({ env: { EMAIL_FROM: FROM, RESEND_API_KEY: 'test' } }),
    ).then((value) => {
      outcome = value;
    });
    await elapse(0);
    await elapse(9_999);
    expect(outcome).toBeNull();
    await elapse(1);
    expect(outcome).toBe('retried');
    expect(fetchMock).toHaveBeenCalledOnce();
    await dispatch;
  });
});
