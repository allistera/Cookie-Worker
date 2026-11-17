import { describe, expect, test } from 'vitest';
import {
  invitationEventRows,
  invitationReplyBlock,
  invitationSender,
  replaceInvitationEvents,
  simpleRecurrenceRule,
  validInvitationTimeZone,
} from '../calendarInvitation.js';

const invitation = (overrides = {}) => ({
  id: 'invitation-1',
  user_id: 'user-1',
  uid: 'team-sync@calendar.example',
  recurrence_id: '',
  status: 'active',
  attendee_address: 'me@cookie.test',
  title: 'Team sync',
  description: null,
  location: null,
  start_at: '2026-12-01T10:00:00.000Z',
  end_at: '2026-12-01T11:00:00.000Z',
  all_day: false,
  recurrence_rule: null,
  time_zone: 'Europe/London',
  ...overrides,
});

/** A mock transaction that answers queries in order and records them. */
function mockTx(results) {
  const queue = [...results];
  /** @type {{text: string, values: unknown[]}[]} */
  const calls = [];
  const tx = (/** @type {TemplateStringsArray} */ strings, /** @type {unknown[]} */ ...values) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  return { tx, calls };
}

describe('invitationSender', () => {
  test('is the bare address mail goes out from', () => {
    expect(invitationSender({ EMAIL_FROM: 'Cookie <Me@Cookie.test>' })).toBe('me@cookie.test');
    expect(invitationSender({ EMAIL_FROM: 'me@cookie.test' })).toBe('me@cookie.test');
  });

  test('is null when sending is not set up', () => {
    expect(invitationSender({})).toBeNull();
    expect(invitationSender({ EMAIL_FROM: '  ' })).toBeNull();
  });
});

describe('validInvitationTimeZone', () => {
  test('accepts an IANA zone and rejects anything else', () => {
    expect(validInvitationTimeZone('Europe/London')).toBe('Europe/London');
    expect(validInvitationTimeZone('Mars/Olympus')).toBeNull();
    expect(validInvitationTimeZone('')).toBeNull();
    expect(validInvitationTimeZone(null)).toBeNull();
    expect(validInvitationTimeZone('x'.repeat(101))).toBeNull();
  });
});

describe('invitationReplyBlock', () => {
  test('lets the address Cookie sends from answer', () => {
    expect(invitationReplyBlock(invitation(), 'me@cookie.test')).toBeNull();
    expect(
      invitationReplyBlock(invitation({ attendee_address: 'Me@Cookie.test' }), 'me@cookie.test'),
    ).toBeNull();
  });

  test('names why an invitation cannot be answered', () => {
    expect(invitationReplyBlock(invitation({ status: 'cancelled' }), 'me@cookie.test')).toBe(
      'cancelled',
    );
    expect(invitationReplyBlock(invitation(), null)).toBe('not_configured');
    expect(invitationReplyBlock(invitation({ attendee_address: null }), 'me@cookie.test')).toBe(
      'not_invited',
    );
    expect(
      invitationReplyBlock(
        invitation({ attendee_address: 'alex@personal.example' }),
        'me@cookie.test',
      ),
    ).toBe('alias');
  });
});

describe('simpleRecurrenceRule', () => {
  const context = {
    day: '2026-12-01',
    sourceDay: '2026-12-01',
    until: (/** @type {string} */ value) =>
      /^\d{8}/.test(value)
        ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
        : null,
  };

  test.each([
    ['FREQ=DAILY', 'DAILY'],
    ['FREQ=WEEKLY;INTERVAL=1;WKST=SU', 'WEEKLY'],
    ['FREQ=WEEKLY;BYDAY=TH,TU', 'WEEKLY;BYDAY=TU,TH'],
    ['FREQ=WEEKLY;UNTIL=20270105T100000Z;BYDAY=TU', 'WEEKLY;BYDAY=TU;UNTIL=2027-01-05'],
    ['FREQ=MONTHLY;BYMONTHDAY=1', 'MONTHLY'],
    ['FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=1', 'YEARLY'],
    ['freq=yearly', 'YEARLY'],
  ])('carries %s over as %s', (rule, expected) => {
    expect(simpleRecurrenceRule(rule, context)).toBe(expected);
  });

  test.each([
    'FREQ=WEEKLY;INTERVAL=2',
    'FREQ=DAILY;COUNT=5',
    'FREQ=MONTHLY;BYDAY=1TU',
    'FREQ=MONTHLY;BYDAY=TU',
    'FREQ=MONTHLY;BYMONTHDAY=15',
    'FREQ=YEARLY;BYMONTH=6',
    'FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR',
    'FREQ=HOURLY',
    'FREQ=WEEKLY;UNTIL=someday',
    'FREQ=WEEKLY;FREQ=DAILY',
    'WEEKLY',
    '',
  ])('has no equivalent for %s', (rule) => {
    expect(simpleRecurrenceRule(rule, context)).toBeNull();
    expect(simpleRecurrenceRule(null, context)).toBeNull();
  });

  test('drops weekdays written for another zone’s day', () => {
    expect(
      simpleRecurrenceRule('FREQ=WEEKLY;BYDAY=TU', { ...context, day: '2026-12-02' }),
    ).toBeNull();
    // Without weekdays the series simply repeats from its first occurrence.
    expect(simpleRecurrenceRule('FREQ=WEEKLY', { ...context, day: '2026-12-02' })).toBe('WEEKLY');
  });
});

describe('invitationEventRows', () => {
  test('places a timed event on the clock of the zone it is shown in', () => {
    expect(invitationEventRows(invitation(), 'America/New_York')).toEqual({
      rows: [
        { date: '2026-12-01', start: '05:00', duration: 60, all_day: false, recurrence_rule: null },
      ],
      recurrence: 'none',
    });
    // Late evening in London is already the next day in Tokyo.
    const late = invitation({
      start_at: '2026-12-01T22:30:00.000Z',
      end_at: '2026-12-01T23:15:00.000Z',
    });
    expect(invitationEventRows(late, 'Asia/Tokyo').rows[0]).toMatchObject({
      date: '2026-12-02',
      start: '07:30',
      duration: 45,
    });
  });

  test('follows daylight saving in the zone it is shown in', () => {
    // 09:00 UTC is 10:00 in London in July and 09:00 in December.
    const summer = invitation({
      start_at: '2026-07-01T09:00:00.000Z',
      end_at: '2026-07-01T10:00:00.000Z',
    });
    expect(invitationEventRows(summer, 'Europe/London').rows[0].start).toBe('10:00');
    expect(
      invitationEventRows(invitation({ start_at: '2026-12-01T09:00:00.000Z' }), 'Europe/London')
        .rows[0].start,
    ).toBe('09:00');
  });

  test('bounds the length of an event', () => {
    const endless = invitation({ end_at: '2027-12-01T10:00:00.000Z' });
    expect(invitationEventRows(endless, 'UTC').rows[0].duration).toBe(30 * 24 * 60);
  });

  test('carries a simple series over and ends it on the local last day', () => {
    const series = invitation({ recurrence_rule: 'FREQ=WEEKLY;UNTIL=20270105T100000Z;BYDAY=TU' });
    expect(invitationEventRows(series, 'Europe/London')).toMatchObject({
      rows: [{ recurrence_rule: 'WEEKLY;BYDAY=TU;UNTIL=2027-01-05' }],
      recurrence: 'series',
    });
  });

  test('keeps only the first occurrence of a series it cannot repeat', () => {
    const fortnightly = invitation({ recurrence_rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU' });
    expect(invitationEventRows(fortnightly, 'Europe/London')).toMatchObject({
      rows: [{ date: '2026-12-01', recurrence_rule: null }],
      recurrence: 'first',
    });
    // Tuesday evening in London is Wednesday morning in Tokyo, so "every
    // Tuesday" no longer describes the days it falls on there.
    const evening = invitation({
      start_at: '2026-12-01T22:30:00.000Z',
      end_at: '2026-12-01T23:30:00.000Z',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU',
    });
    expect(invitationEventRows(evening, 'Asia/Tokyo').recurrence).toBe('first');
  });

  test('treats one occurrence of a series as an event of its own', () => {
    const occurrence = invitation({
      recurrence_id: '20261208T100000Z',
      recurrence_rule: 'FREQ=WEEKLY',
    });
    expect(invitationEventRows(occurrence, 'Europe/London')).toMatchObject({
      rows: [{ recurrence_rule: null }],
      recurrence: 'none',
    });
  });

  test('stores an all-day event as one row per day, whatever the zone', () => {
    const offsite = invitation({
      all_day: true,
      start_at: '2026-12-24T00:00:00.000Z',
      end_at: '2026-12-26T00:00:00.000Z',
      time_zone: null,
    });
    for (const zone of ['Pacific/Auckland', 'America/Los_Angeles']) {
      expect(invitationEventRows(offsite, zone).rows).toEqual([
        {
          date: '2026-12-24',
          start: '00:00',
          duration: 1440,
          all_day: true,
          recurrence_rule: null,
        },
        {
          date: '2026-12-25',
          start: '00:00',
          duration: 1440,
          all_day: true,
          recurrence_rule: null,
        },
      ]);
    }
  });

  test('repeats a one-day all-day series and caps a very long all-day span', () => {
    const birthday = invitation({
      all_day: true,
      start_at: '2026-12-24T00:00:00.000Z',
      end_at: '2026-12-25T00:00:00.000Z',
      recurrence_rule: 'FREQ=YEARLY;UNTIL=20301224',
    });
    expect(invitationEventRows(birthday, 'UTC')).toMatchObject({
      rows: [{ date: '2026-12-24', recurrence_rule: 'YEARLY;UNTIL=2030-12-24' }],
      recurrence: 'series',
    });
    const sabbatical = invitation({
      all_day: true,
      start_at: '2026-01-01T00:00:00.000Z',
      end_at: '2026-12-31T00:00:00.000Z',
      recurrence_rule: 'FREQ=YEARLY',
    });
    const { rows, recurrence } = invitationEventRows(sabbatical, 'UTC');
    expect(rows).toHaveLength(31);
    expect(recurrence).toBe('first');
  });
});

describe('replaceInvitationEvents', () => {
  const options = { timeZone: 'Europe/London', tone: 'accepted' };

  test('replaces the entries in the calendar they are filed under', async () => {
    const { tx, calls } = mockTx([
      [{ calendar: 'calendar-1', on_calendar: true, series_on_calendar: false }],
      [],
      [{ id: 'event-1', date: '2026-12-01' }],
    ]);
    const result = await replaceInvitationEvents(tx, invitation(), options);

    expect(result).toEqual({ event: { id: 'event-1', date: '2026-12-01' }, recurrence: 'none' });
    expect(calls).toHaveLength(3);
    expect(calls[1].text).toContain('DELETE FROM calendar_events');
    expect(calls[2].text).toContain('INSERT INTO calendar_events');
    expect(calls[2].values).toContain('calendar-1');
    expect(calls[2].values).toContain('accepted');
    expect(calls[2].values).toContainEqual([
      { date: '2026-12-01', start: '10:00', duration: 60, all_day: false, recurrence_rule: null },
    ]);
  });

  test('adds nothing without a calendar to file the event in', async () => {
    const { tx, calls } = mockTx([
      [{ calendar: null, on_calendar: false, series_on_calendar: false }],
    ]);
    expect(await replaceInvitationEvents(tx, invitation(), options)).toEqual({
      event: null,
      recurrence: 'none',
    });
    expect(calls).toHaveLength(1);
  });

  test('only updates entries that exist when told to add none', async () => {
    const { tx, calls } = mockTx([
      [{ calendar: 'calendar-1', on_calendar: false, series_on_calendar: false }],
    ]);
    const result = await replaceInvitationEvents(tx, invitation(), {
      ...options,
      onlyIfPresent: true,
    });
    expect(result.event).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('leaves one occurrence off while its series is on the calendar', async () => {
    const occurrence = invitation({ id: 'invitation-2', recurrence_id: '20261208T100000Z' });
    const beside = mockTx([
      [{ calendar: 'calendar-1', on_calendar: false, series_on_calendar: true }],
    ]);
    expect((await replaceInvitationEvents(beside.tx, occurrence, options)).event).toBeNull();
    expect(beside.calls).toHaveLength(1);

    // With no series there, the occurrence is the event.
    const alone = mockTx([
      [{ calendar: 'calendar-1', on_calendar: false, series_on_calendar: false }],
      [],
      [{ id: 'event-2', date: '2026-12-01' }],
    ]);
    expect((await replaceInvitationEvents(alone.tx, occurrence, options)).event).toEqual({
      id: 'event-2',
      date: '2026-12-01',
    });
  });
});
