import { beforeEach, describe, expect, it, vi } from 'vitest';
import ical from 'node-ical';
import { manageCalendarFeeds, readCalendarFeed, serializeCalendar } from '../src/calendarFeeds.js';

const allowRequest = vi.hoisted(() => vi.fn());
vi.mock('../../../shared/rate-limit.js', () => ({ allowRequest }));

const calendarId = '11111111-1111-4111-8111-111111111111';
const userId = '99999999-9999-4999-8999-999999999999';
const token = 'a'.repeat(64);
const event = {
  id: '22222222-2222-4222-8222-222222222222',
  calendarName: 'Work',
  title: 'Planning',
  description: 'Discuss next week',
  location: 'Office',
  date: '2026-01-31',
  start: '09:30',
  duration: 60,
  allDay: false,
  recurrenceRule: null,
  updatedAt: new Date('2026-01-01T10:00:00Z'),
};

function database(rows = []) {
  return vi.fn(/** @param {any[]} _args */ async (..._args) => rows);
}

function request(method = 'GET', body, headers = {}) {
  return new Request(`https://calendar.example/calendar-feed.ics?token=${token}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => allowRequest.mockResolvedValue(true));

describe('private feed management', () => {
  it('returns only calendar identifiers on status reads, scoped to the owner', async () => {
    const sql = database([{ calendarId }]);
    const response = await manageCalendarFeeds(sql, userId, request());
    expect(await response.json()).toEqual({ feeds: [{ calendarId }] });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(sql.mock.calls[0][0].join('?')).toContain('f.user_id =');
    expect(sql.mock.calls[0].slice(1)).toEqual([userId]);
  });

  it('generates distinct tokens, storing only their hashes for owned native calendars', async () => {
    const sql = database([{ calendarId }]);
    const first = await manageCalendarFeeds(sql, userId, request('POST', { calendarId }));
    const { token: firstToken } = await first.json();
    const second = await manageCalendarFeeds(sql, userId, request('POST', { calendarId }));
    const { token: secondToken } = await second.json();
    expect(first.status).toBe(201);
    expect(firstToken).toMatch(/^[0-9a-f]{64}$/);
    expect(secondToken).not.toBe(firstToken);
    const query = sql.mock.calls[0][0].join('?');
    expect(query).toContain('c.user_id =');
    expect(query).toContain('c.subscription_url IS NULL');
    expect(query).toContain('ON CONFLICT (calendar_id) DO UPDATE');
    expect(sql.mock.calls[0].slice(1)).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      calendarId,
      userId,
    ]);
    expect(sql.mock.calls.flat()).not.toContain(firstToken);
    expect(sql.mock.calls.flat()).not.toContain(secondToken);
  });

  it('rejects missing, foreign, and subscribed calendars without returning a token', async () => {
    const response = await manageCalendarFeeds(database(), userId, request('POST', { calendarId }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Calendar not found' });
  });

  it.each([null, {}, { calendarId: 'google:primary' }])(
    'rejects invalid inputs %s',
    async (body) => {
      const sql = database();
      const response = await manageCalendarFeeds(sql, userId, request('POST', body));
      expect(response.status).toBe(400);
      expect(sql).not.toHaveBeenCalled();
    },
  );

  it('revokes idempotently without allowing a different owner to delete the feed', async () => {
    const sql = database();
    const response = await manageCalendarFeeds(sql, userId, request('DELETE', { calendarId }));
    expect(response.status).toBe(200);
    expect(sql.mock.calls[0][0].join('?')).toContain('AND user_id =');
    expect(sql.mock.calls[0].slice(1)).toEqual([calendarId, userId]);
  });

  it('rate limits generation and returns a retry delay', async () => {
    allowRequest.mockResolvedValue(false);
    const sql = database();
    const response = await manageCalendarFeeds(sql, userId, request('POST', { calendarId }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(sql).not.toHaveBeenCalled();
  });

  it('handles rollout before the new migration without affecting other calendar APIs', async () => {
    const sql = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('not migrated'), { code: '42P01' }));
    const response = await manageCalendarFeeds(sql, userId, request());
    expect(response.status).toBe(503);
  });
});

describe('iCalendar export', () => {
  it('round trips text, prevents property injection, and folds UTF-8 lines at 75 bytes', () => {
    const title = 'Discuss 🥐, coffee; plans\\notes '.repeat(8);
    const description = 'First\r\nATTENDEE:injected@example.com\nSecond';
    const text = serializeCalendar('My calendar\r\nX-FAKE:injected', [
      { ...event, title, description },
    ]);
    for (const line of text.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(text.endsWith('\r\n')).toBe(true);
    const parsed = ical.parseICS(text);
    const item = /** @type {any} */ (parsed[`${event.id}@cookie.calendar`]);
    expect(item.summary).toBe(title);
    expect(item.description).toBe(description.replace(/\r\n/g, '\n'));
    expect(item.attendee).toBeUndefined();
    expect(text).toContain('DTSTART:20260131T093000\r\n');
    expect(text).toContain('DTEND:20260131T103000\r\n');
    expect(text).toContain('DTSTAMP:20260101T100000Z\r\n');
  });

  it('exports multi-day all-day spans with an exclusive date-only end', () => {
    const text = serializeCalendar('Work', [{ ...event, allDay: true, duration: 2880 }]);
    expect(text).toContain('DTSTART;VALUE=DATE:20260131\r\n');
    expect(text).toContain('DTEND;VALUE=DATE:20260202\r\n');
  });

  it('rolls overnight timed events into the following date', () => {
    const text = serializeCalendar('Work', [{ ...event, start: '23:30', duration: 120 }]);
    expect(text).toContain('DTEND:20260201T013000\r\n');
  });

  it('starts weekday series on the first matching day and includes the last day', () => {
    const text = serializeCalendar('Work', [
      {
        ...event,
        recurrenceRule: 'WEEKLY;BYDAY=MO,WE;UNTIL=2026-02-09',
      },
    ]);
    expect(text).toContain('DTSTART:20260202T093000');
    expect(text).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260209T235959');
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it('does not invent an occurrence when a series ends before its first matching day', () => {
    const text = serializeCalendar('Work', [
      { ...event, recurrenceRule: 'WEEKLY;BYDAY=MO;UNTIL=2026-02-01' },
    ]);
    expect(text).not.toContain('BEGIN:VEVENT');
  });

  it.each([
    ['MONTHLY', '2026-01-31', ['2026-01-31', '2026-02-28', '2026-03-31']],
    ['MONTHLY', '2026-01-30', ['2026-01-30', '2026-02-28', '2026-03-30']],
    ['YEARLY', '2024-02-29', ['2024-02-29', '2025-02-28', '2026-02-28']],
  ])('preserves Cookie’s clamped %s series', (recurrenceRule, date, dates) => {
    const text = serializeCalendar('Work', [{ ...event, date, recurrenceRule }]);
    const parsed = /** @type {any} */ (ical.parseICS(text)[`${event.id}@cookie.calendar`]);
    const actual = parsed.rrule
      .all((_, index) => index < 3)
      .map((value) => value.toISOString().slice(0, 10));
    expect(actual).toEqual(dates);
  });
});

describe('read-only feed HTTP behaviour', () => {
  it('returns a private feed with an opaque ETag, without putting the token in SQL', async () => {
    const sql = database([event]);
    const response = await readCalendarFeed(sql, request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('SUMMARY:Planning');
    expect(sql.mock.calls[0].slice(1)).not.toContain(token);
    const query = sql.mock.calls[0][0].join('?');
    expect(query).toContain('ce.user_id = c.user_id');
    expect(query).toContain('c.subscription_url IS NULL');
  });

  it('supports HEAD and conditional requests only after validating the current token', async () => {
    const sql = database([event]);
    const initial = await readCalendarFeed(sql, request());
    const etag = initial.headers.get('ETag');
    const conditional = await readCalendarFeed(
      sql,
      request('GET', undefined, { 'If-None-Match': `W/${etag}` }),
    );
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
    const head = await readCalendarFeed(sql, request('HEAD'));
    expect(head.headers.get('ETag')).toBe(etag);
    expect(await head.text()).toBe('');
    const revoked = await readCalendarFeed(
      database(),
      request('GET', undefined, { 'If-None-Match': etag }),
    );
    expect(revoked.status).toBe(404);
  });

  it('changes the ETag on edits, deletions, and calendar renames', async () => {
    const initial = await readCalendarFeed(database([event]), request());
    for (const rows of [
      [{ ...event, title: 'Changed' }],
      [{ calendarName: 'Work', id: null }],
      [{ ...event, calendarName: 'Renamed' }],
    ]) {
      const updated = await readCalendarFeed(database(rows), request());
      expect(updated.headers.get('ETag')).not.toBe(initial.headers.get('ETag'));
    }
  });

  it('returns an empty calendar after its last event is deleted', async () => {
    const response = await readCalendarFeed(
      database([{ calendarName: 'Work', id: null }]),
      request(),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).not.toContain('BEGIN:VEVENT');
  });

  it('rejects missing, invalid, or revoked tokens and refuses writes', async () => {
    const sql = database();
    for (const url of [
      'https://calendar.example/calendar-feed.ics',
      'https://calendar.example/calendar-feed.ics?token=invalid',
    ]) {
      expect((await readCalendarFeed(sql, new Request(url))).status).toBe(404);
    }
    expect(sql).not.toHaveBeenCalled();
    expect((await readCalendarFeed(sql, request())).status).toBe(404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await readCalendarFeed(sql, request(method));
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD');
    }
  });

  it('fails rather than presenting a truncated feed as a successful deletion', async () => {
    const response = await readCalendarFeed(
      database(Array.from({ length: 10_001 }, () => event)),
      request(),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('');
  });
});
