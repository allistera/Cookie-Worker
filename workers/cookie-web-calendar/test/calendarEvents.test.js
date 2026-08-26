// Ported from Cookie-Web's api/__tests__/calendar-events.test.js — the
// recurrence and fetch halves, unchanged.
import { describe, expect, it } from 'vitest';

import { buildRecurrenceRule, expandEvents, parseRangeParams } from '../src/recurrence.js';
import { fetchEvents } from '../src/calendarEvents.js';

describe('buildRecurrenceRule', () => {
  it('returns null for "none"', () => {
    expect(buildRecurrenceRule('none', null, null)).toBeNull();
  });

  it('omits BYDAY for non-weekly frequencies even if repeatDays is set', () => {
    expect(buildRecurrenceRule('daily', null, ['MO', 'TU'])).toBe('DAILY');
  });

  it('includes BYDAY for weekly with specific days, before UNTIL', () => {
    expect(buildRecurrenceRule('weekly', '2026-12-31', ['MO', 'TU', 'WE', 'TH', 'FR'])).toBe(
      'WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=2026-12-31',
    );
  });

  it('omits BYDAY for weekly with no days selected', () => {
    expect(buildRecurrenceRule('weekly', null, [])).toBe('WEEKLY');
  });
});

const USER_ID = '99999999-9999-9999-9999-999999999999';

describe('fetchEvents', () => {
  it('normalizes legacy calendar slugs to owned calendar ids', async () => {
    let query = '';
    const values = [];
    /** @type {any} */ const sql = (strings, ...vals) => {
      query = strings.join('?');
      values.push(...vals);
      return [];
    };

    await fetchEvents(sql, USER_ID);

    expect(query).toContain('FROM calendar_events ce');
    expect(query).toContain('LEFT JOIN calendars c');
    expect(query).toContain('COALESCE(c.id::text, ce.calendar::text) AS calendar');
    expect(query).toContain('WHERE ce.user_id =');
    expect(query).toContain('ce.event_date AS date');
    expect(query).toContain('ce.start_time AS start');
    expect(query).toContain('ce.duration_minutes AS duration');
    expect(query).toContain('ce.recurrence_rule AS "recurrenceRule"');
    expect(query).toContain('ce.all_day AS "allDay"');
    expect(query).toContain('ce.is_auto_scheduled AS "autoScheduled"');
    expect(query).toContain('ORDER BY ce.event_date, ce.start_time');
    // No range binds the full date domain — the return-everything contract.
    expect(values).toEqual([USER_ID, '0001-01-01', '9999-12-31']);
  });

  it('windows non-recurring rows by event_date but keeps recurring masters', async () => {
    let query = '';
    const values = [];
    /** @type {any} */ const sql = (strings, ...vals) => {
      query = strings.join('?');
      values.push(...vals);
      return [];
    };

    await fetchEvents(sql, USER_ID, { from: '2026-08-01', to: '2026-09-30' });

    expect(query).toContain('ce.recurrence_rule IS NOT NULL');
    expect(query).toContain('OR ce.event_date BETWEEN');
    expect(values).toEqual([USER_ID, '2026-08-01', '2026-09-30']);
  });

  it('falls back to legacy event reads before the expand migration', async () => {
    const queries = [];
    let calls = 0;
    /** @type {any} */ const sql = (strings) => {
      queries.push(strings.join('?'));
      calls += 1;
      if (calls === 1)
        return Promise.reject(Object.assign(new Error('missing table'), { code: '42P01' }));
      return [];
    };

    await fetchEvents(sql, USER_ID);

    expect(queries).toHaveLength(2);
    expect(queries[1]).not.toContain('JOIN calendars');
    expect(queries[1]).toContain('ce.calendar');
  });

  it('falls back to a recurrence-free read before migration 0025 lands', async () => {
    const queries = [];
    let calls = 0;
    /** @type {any} */ const sql = (strings) => {
      queries.push(strings.join('?'));
      calls += 1;
      if (calls === 1)
        return Promise.reject(Object.assign(new Error('missing column'), { code: '42703' }));
      return [];
    };

    await fetchEvents(sql, USER_ID);

    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('LEFT JOIN calendars');
    expect(queries[1]).not.toContain('recurrence_rule');
    // Also predates 0033: a DB this old can't have is_auto_scheduled either.
    expect(queries[1]).not.toContain('is_auto_scheduled');
  });
});

describe('expandEvents', () => {
  const now = new Date('2026-07-28T00:00:00Z');

  it('passes non-recurring events through unchanged, with seriesId set to their own id', () => {
    const event = { id: 'abc', date: '2026-08-01', start: '09:00', recurrenceRule: null };

    expect(expandEvents([event], now)).toEqual([{ ...event, seriesId: 'abc' }]);
  });

  it('expands a weekly series into occurrences within the window', () => {
    const event = {
      id: 'abc',
      date: '2026-07-01',
      start: '09:00',
      recurrenceRule: 'WEEKLY;UNTIL=2026-07-22',
    };

    const occurrences = expandEvents([event], now);

    expect(occurrences.map((occurrence) => occurrence.date)).toEqual([
      '2026-07-01',
      '2026-07-08',
      '2026-07-15',
      '2026-07-22',
    ]);
    expect(occurrences.every((occurrence) => occurrence.seriesId === 'abc')).toBe(true);
    expect(occurrences.every((occurrence) => occurrence.seriesDate === '2026-07-01')).toBe(true);
    expect(new Set(occurrences.map((occurrence) => occurrence.id)).size).toBe(occurrences.length);
  });

  it('clips recurring expansion to an explicit range instead of the now-relative window', () => {
    const event = { id: 'abc', date: '2026-01-05', start: '09:00', recurrenceRule: 'WEEKLY' };

    const occurrences = expandEvents([event], now, { from: '2026-08-03', to: '2026-08-16' });

    expect(occurrences.map((occurrence) => occurrence.date)).toEqual(['2026-08-03', '2026-08-10']);
    expect(occurrences.every((occurrence) => occurrence.seriesDate === '2026-01-05')).toBe(true);
  });

  it('clamps monthly recurrence to the last day of short months', () => {
    const event = {
      id: 'abc',
      date: '2026-01-31',
      start: '09:00',
      recurrenceRule: 'MONTHLY;UNTIL=2026-04-01',
    };

    const occurrences = expandEvents([event], now);

    expect(occurrences.map((occurrence) => occurrence.date)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-28',
    ]);
  });

  it('stops generating occurrences once the window ends when there is no UNTIL', () => {
    const event = { id: 'abc', date: '2026-07-27', start: '09:00', recurrenceRule: 'DAILY' };

    const occurrences = expandEvents([event], now);

    expect(occurrences.length).toBeGreaterThan(0);
    expect(occurrences.at(-1).date <= '2029-07-28').toBe(true);
  });

  // Occurrences before the window are stepped over without being emitted, so
  // the per-series occurrence cap alone leaves the loop unbounded. Both
  // DATE_RE and migration 0022's CHECK accept a year-0001 event_date, so any
  // user could otherwise make every calendar load burn ~740k steps per series.
  it('bounds stepping for a series dated far before the window', () => {
    const ancient = { id: 'abc', date: '0001-01-01', start: '09:00', recurrenceRule: 'DAILY' };

    const started = Date.now();
    const occurrences = expandEvents(
      Array.from({ length: 20 }, (_unused, index) => ({ ...ancient, id: `e${index}` })),
      now,
    );

    expect(Date.now() - started).toBeLessThan(1000);
    expect(occurrences.length).toBeLessThanOrEqual(20 * 366);
  });

  it('still expands long-running realistic series that predate the window', () => {
    const birthday = { id: 'abc', date: '1985-03-04', start: '09:00', recurrenceRule: 'YEARLY' };

    expect(expandEvents([birthday], now).map((occurrence) => occurrence.date)).toEqual([
      '2026-03-04',
      '2027-03-04',
      '2028-03-04',
    ]);
  });

  it('expands a weekly BYDAY series onto only the selected weekdays', () => {
    // 2026-07-27 is a Monday.
    const event = {
      id: 'abc',
      date: '2026-07-27',
      start: '09:00',
      recurrenceRule: 'WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=2026-08-07',
    };

    const occurrences = expandEvents([event], now);

    expect(occurrences.map((occurrence) => occurrence.date)).toEqual([
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-30',
      '2026-07-31',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
    ]);
    expect(occurrences.every((occurrence) => occurrence.seriesId === 'abc')).toBe(true);
    expect(new Set(occurrences.map((occurrence) => occurrence.id)).size).toBe(occurrences.length);
  });

  it('skips the series start date for a weekly BYDAY series if its weekday is not selected', () => {
    // 2026-08-01 is a Saturday, not in the Monday-Friday selection.
    const event = {
      id: 'abc',
      date: '2026-08-01',
      start: '09:00',
      recurrenceRule: 'WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=2026-08-05',
    };

    const occurrences = expandEvents([event], now);

    expect(occurrences.map((occurrence) => occurrence.date)).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
    ]);
  });
});

describe('parseRangeParams', () => {
  it('defaults an omitted range to the expand window rather than the full date domain', () => {
    const now = new Date('2026-07-28T00:00:00Z');
    const range = /** @type {{from: string, to: string}} */ (
      parseRangeParams(new URL('/calendar-events', 'http://localhost').searchParams, now).range
    );
    expect(range.from).toBe(
      now.toISOString().slice(0, 10) === '2026-07-28'
        ? new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        : range.from,
    );
    expect(range.to).toBe(
      new Date(now.getTime() + 730 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    );
    expect(range.from < range.to).toBe(true);
    expect(range.from).not.toBe('0001-01-01');
  });

  it('rejects a range longer than 800 days', () => {
    const url = new URL('/calendar-events?from=2020-01-01&to=2024-01-01', 'http://localhost');
    expect(parseRangeParams(url.searchParams).error).toBe(true);
  });
});
