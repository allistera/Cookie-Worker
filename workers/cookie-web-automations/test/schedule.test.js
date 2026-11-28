import { describe, expect, test } from 'vitest';
import { localDate, nextRunAt, normalizeTrigger, TriggerError } from '../src/schedule.js';

const EVERY_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** @param {Partial<{time: string, days: string[], timeZone: string}>} [overrides] */
function trigger(overrides = {}) {
  return normalizeTrigger({
    type: 'schedule',
    time: '00:00',
    days: EVERY_DAY,
    timeZone: 'Europe/London',
    ...overrides,
  });
}

describe('normalizeTrigger', () => {
  test('keeps a complete schedule, with its days in week order', () => {
    expect(
      normalizeTrigger({
        type: 'schedule',
        time: '07:30',
        days: ['fri', 'mon', 'mon'],
        timeZone: ' America/New_York ',
        extra: 'dropped',
      }),
    ).toEqual({
      type: 'schedule',
      time: '07:30',
      days: ['mon', 'fri'],
      timeZone: 'America/New_York',
    });
  });

  test.each([
    ['a missing trigger', undefined],
    ['another type', { type: 'event', time: '07:30', days: ['mon'], timeZone: 'UTC' }],
    ['a 12-hour time', { type: 'schedule', time: '7:30pm', days: ['mon'], timeZone: 'UTC' }],
    ['an hour past 23', { type: 'schedule', time: '24:00', days: ['mon'], timeZone: 'UTC' }],
    ['no days', { type: 'schedule', time: '07:30', days: [], timeZone: 'UTC' }],
    [
      'an unknown day',
      { type: 'schedule', time: '07:30', days: ['mon', 'someday'], timeZone: 'UTC' },
    ],
    [
      'an unknown zone',
      { type: 'schedule', time: '07:30', days: ['mon'], timeZone: 'Mars/Olympus' },
    ],
    ['no zone', { type: 'schedule', time: '07:30', days: ['mon'] }],
  ])('refuses %s', (_label, input) => {
    expect(() => normalizeTrigger(input)).toThrow(TriggerError);
  });
});

describe('nextRunAt', () => {
  test('falls later the same day when the time has not passed yet', () => {
    expect(nextRunAt(trigger({ time: '18:00' }), new Date('2026-11-28T15:00:00Z'))).toEqual(
      new Date('2026-11-28T18:00:00Z'),
    );
  });

  test('falls on the next day once the time has passed, and never on the instant itself', () => {
    expect(nextRunAt(trigger(), new Date('2026-11-28T00:00:00Z'))).toEqual(
      new Date('2026-11-29T00:00:00Z'),
    );
  });

  test('keeps the wall-clock time in the schedule’s own zone', () => {
    // Midnight in New York in November is 05:00 UTC.
    expect(
      nextRunAt(trigger({ timeZone: 'America/New_York' }), new Date('2026-11-28T15:00:00Z')),
    ).toEqual(new Date('2026-11-29T05:00:00Z'));
  });

  test('stays at the same wall-clock time across a clock change', () => {
    // British clocks go forward on 29 March 2026: 09:00 is 09:00 UTC the day
    // before and 08:00 UTC the day after.
    const nineOClock = trigger({ time: '09:00' });
    expect(nextRunAt(nineOClock, new Date('2026-03-28T08:00:00Z'))).toEqual(
      new Date('2026-03-28T09:00:00Z'),
    );
    expect(nextRunAt(nineOClock, new Date('2026-03-28T09:00:00Z'))).toEqual(
      new Date('2026-03-29T08:00:00Z'),
    );
  });

  test('skips to the next chosen day of the week', () => {
    // 28 November 2026 is a Saturday.
    expect(nextRunAt(trigger({ days: ['mon', 'wed'] }), new Date('2026-11-28T15:00:00Z'))).toEqual(
      new Date('2026-11-30T00:00:00Z'),
    );
  });

  test('waits a week when the only chosen day’s time has passed today', () => {
    expect(
      nextRunAt(trigger({ time: '09:00', days: ['sat'] }), new Date('2026-11-28T15:00:00Z')),
    ).toEqual(new Date('2026-12-05T09:00:00Z'));
  });
});

describe('localDate', () => {
  test('gives the date where the person is, not the UTC date', () => {
    const instant = new Date('2026-11-28T23:30:00Z');
    expect(localDate('Europe/London', instant)).toBe('2026-11-28');
    expect(localDate('Asia/Tokyo', instant)).toBe('2026-11-29');
    expect(localDate('America/Los_Angeles', instant)).toBe('2026-11-28');
  });
});
