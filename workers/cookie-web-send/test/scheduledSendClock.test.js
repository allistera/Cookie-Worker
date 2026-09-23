import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledSendClock } from '../src/scheduledSendClock.js';

const ENV = { HYPERDRIVE: { connectionString: 'postgres://stub' } };

/** @returns {any} */
function fakeState() {
  /** @type {number | null} */
  let alarm = null;
  return {
    storage: {
      getAlarm: vi.fn(async () => alarm),
      setAlarm: vi.fn(async (/** @type {number} */ at) => {
        alarm = at;
      }),
      deleteAlarm: vi.fn(async () => {
        alarm = null;
      }),
    },
    waitUntil: vi.fn(),
    current: () => alarm,
  };
}

/** @param {unknown[][]} rows @returns {any} */
function fakeSql(rows = []) {
  const queue = [...rows];
  const sql = /** @type {any} */ (vi.fn(() => Promise.resolve(queue.length ? queue.shift() : [])));
  sql.end = vi.fn(async () => undefined);
  return sql;
}

function arm(at) {
  return new Request('https://clock/arm', {
    method: 'POST',
    body: JSON.stringify({ at }),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ScheduledSendClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T12:00:00.000Z'));
  });

  it('arms the alarm for a future send when none is set', async () => {
    const state = fakeState();
    const clock = new ScheduledSendClock(state, ENV, {});

    const response = await clock.fetch(arm('2026-09-23T12:30:00.000Z'));

    expect(response.status).toBe(204);
    expect(state.current()).toBe(Date.parse('2026-09-23T12:30:00.000Z'));
  });

  it('keeps an earlier alarm when a later send is queued', async () => {
    const state = fakeState();
    const clock = new ScheduledSendClock(state, ENV, {});
    await clock.fetch(arm('2026-09-23T12:30:00.000Z'));

    await clock.fetch(arm('2026-09-23T13:00:00.000Z'));

    expect(state.current()).toBe(Date.parse('2026-09-23T12:30:00.000Z'));
    expect(state.storage.setAlarm).toHaveBeenCalledTimes(1);
  });

  it('moves the alarm earlier when an earlier send is queued', async () => {
    const state = fakeState();
    const clock = new ScheduledSendClock(state, ENV, {});
    await clock.fetch(arm('2026-09-23T13:00:00.000Z'));

    await clock.fetch(arm('2026-09-23T12:30:00.000Z'));

    expect(state.current()).toBe(Date.parse('2026-09-23T12:30:00.000Z'));
  });

  it('never arms in the past: a due time already gone fires now', async () => {
    const state = fakeState();
    const clock = new ScheduledSendClock(state, ENV, {});

    await clock.fetch(arm('2026-09-23T11:00:00.000Z'));

    expect(state.current()).toBe(Date.now());
  });

  it('rejects a body without a parseable time', async () => {
    const state = fakeState();
    const clock = new ScheduledSendClock(state, ENV, {});

    const response = await clock.fetch(arm('soon'));

    expect(response.status).toBe(400);
    expect(state.storage.setAlarm).not.toHaveBeenCalled();
  });

  it('answers 404 for anything but POST /arm', async () => {
    const clock = new ScheduledSendClock(fakeState(), ENV, {});
    expect((await clock.fetch(new Request('https://clock/other', { method: 'POST' }))).status).toBe(
      404,
    );
  });

  it('fires the flush on alarm and re-arms from the next pending send', async () => {
    const state = fakeState();
    const sql = fakeSql([[{ next: new Date('2026-09-23T14:00:00.000Z') }]]);
    const flush = vi.fn(async () => ({ claimed: 1 }));
    const services = {};
    const createServices = vi.fn(() => services);
    const clock = new ScheduledSendClock(
      state,
      ENV,
      /** @type {any} */ ({
        createSql: () => sql,
        flush,
        createServices,
      }),
    );

    await clock.alarm();

    expect(flush).toHaveBeenCalledWith(sql, services);
    expect(createServices).toHaveBeenCalledWith(ENV, state);
    expect(state.current()).toBe(Date.parse('2026-09-23T14:00:00.000Z'));
    expect(sql.end).toHaveBeenCalled();
  });

  it('leaves no alarm when nothing further is pending', async () => {
    const state = fakeState();
    const sql = fakeSql([[{ next: null }]]);
    const clock = new ScheduledSendClock(
      state,
      ENV,
      /** @type {any} */ ({
        createSql: () => sql,
        flush: vi.fn(async () => ({})),
        createServices: () => ({}),
      }),
    );

    await clock.alarm();

    expect(state.current()).toBe(null);
  });

  it('still re-arms when the flush itself fails, leaving retries to the cron', async () => {
    const state = fakeState();
    const sql = fakeSql([[{ next: new Date('2026-09-23T14:00:00.000Z') }]]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const clock = new ScheduledSendClock(
      state,
      ENV,
      /** @type {any} */ ({
        createSql: () => sql,
        flush: vi.fn(async () => {
          throw new Error('provider down');
        }),
        createServices: () => ({}),
      }),
    );

    await expect(clock.alarm()).resolves.toBeUndefined();

    expect(state.current()).toBe(Date.parse('2026-09-23T14:00:00.000Z'));
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'scheduled_send_alarm_failed', error: 'provider down' }),
    );
    expect(sql.end).toHaveBeenCalled();
    log.mockRestore();
  });
});
