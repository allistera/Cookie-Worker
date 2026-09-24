import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calendarAvailability,
  nativeBusyIntervals,
  subscriptionBusyIntervals,
  validateAvailabilityRequest,
} from '../src/calendarAvailability.js';
import { mergeBusy, wallTimeToInstant } from '../src/availabilityTime.js';

const allowRequest = vi.hoisted(() => vi.fn());
vi.mock('../../../shared/rate-limit.js', () => ({ allowRequest }));
const calendarId = '11111111-1111-1111-1111-111111111111';
const otherId = '22222222-2222-2222-2222-222222222222';
const body = {
  calendarIds: [calendarId],
  from: '2026-10-24',
  to: '2026-10-26',
  timeZone: 'Europe/London',
  interpretationTimeZone: 'Europe/London',
  confirmFloatingTimes: true,
};
const window = {
  start: Date.parse('2026-10-23T23:00:00Z'),
  end: Date.parse('2026-10-27T00:00:00Z'),
};
const event = {
  id: 'one',
  date: '2026-10-24',
  start: '09:00',
  duration: 60,
  allDay: false,
  recurrenceRule: null,
};
const feed = (events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}\r\nEND:VCALENDAR`;
const vevent = (fields) =>
  `BEGIN:VEVENT\r\nUID:one\r\nSUMMARY:Private meeting title\r\n${fields}\r\nEND:VEVENT`;

beforeEach(() => allowRequest.mockReset().mockResolvedValue(true));

describe('availability wall times and native events', () => {
  it('rejects invalid dates, missing consent, empty/duplicate calendars and unbounded ranges', () => {
    expect(validateAvailabilityRequest(body)).toBe(true);
    for (const change of [
      { calendarIds: [] },
      { calendarIds: [calendarId, calendarId] },
      { confirmFloatingTimes: false },
      { from: '2026-02-30' },
      { to: '2027-01-01' },
      { timeZone: 'Unknown/Zone' },
    ]) {
      expect(validateAvailabilityRequest({ ...body, ...change })).toBe(false);
    }
  });

  it('round trips IANA offsets and rejects the missing and repeated London hour', () => {
    expect(wallTimeToInstant('2026-10-24', '09:00', 'Europe/London')).toBe(
      Date.parse('2026-10-24T08:00:00Z'),
    );
    expect(() => wallTimeToInstant('2026-03-29', '01:30', 'Europe/London')).toThrow(
      'Ambiguous or nonexistent',
    );
    expect(() => wallTimeToInstant('2026-10-25', '01:30', 'Europe/London')).toThrow(
      'Ambiguous or nonexistent',
    );
    expect(wallTimeToInstant('2026-10-24', '09:00', 'Asia/Kathmandu')).toBe(
      Date.parse('2026-10-24T03:15:00Z'),
    );
  });

  it('expands native recurrence across DST in the confirmed zone', () => {
    const intervals = nativeBusyIntervals([{ ...event, recurrenceRule: 'DAILY' }], body, window);
    expect(intervals.map((busy) => new Date(busy.start).toISOString())).toEqual([
      '2026-10-24T08:00:00.000Z',
      '2026-10-25T09:00:00.000Z',
      '2026-10-26T09:00:00.000Z',
    ]);
  });

  it('includes overnight events and gives an all-day event the actual 25-hour day', () => {
    const intervals = nativeBusyIntervals(
      [
        { ...event, date: '2026-10-23', start: '23:30', duration: 120 },
        { ...event, date: '2026-10-25', allDay: true, duration: 1440 },
      ],
      body,
      window,
    );
    expect(intervals[0]).toEqual({
      start: Date.parse('2026-10-23T22:30Z'),
      end: Date.parse('2026-10-24T00:30Z'),
    });
    expect(intervals[1].end - intervals[1].start).toBe(25 * 3_600_000);
  });

  it('unions nested and overlapping conflicts from different calendars', () => {
    expect(
      mergeBusy([
        { start: 30, end: 70 },
        { start: 0, end: 40 },
        { start: 10, end: 15 },
        { start: 70, end: 80 },
        { start: 100, end: 110 },
      ]),
    ).toEqual([
      { start: 0, end: 80 },
      { start: 100, end: 110 },
    ]);
  });

  it('fails closed for invalid, ambiguous, or excessive native event data', () => {
    expect(() =>
      nativeBusyIntervals([{ ...event, date: '2026-10-25', start: '01:30' }], body, window),
    ).toThrow();
    expect(() =>
      nativeBusyIntervals([{ ...event, recurrenceRule: 'UNKNOWN' }], body, window),
    ).toThrow();
    expect(() =>
      nativeBusyIntervals(
        Array.from({ length: 1001 }, () => event),
        body,
        window,
      ),
    ).toThrow();
    expect(() =>
      nativeBusyIntervals(
        Array.from({ length: 1000 }, () => ({
          ...event,
          recurrenceRule: 'DAILY',
          date: '2026-09-01',
        })),
        body,
        window,
      ),
    ).toThrow('Incomplete');
  });
});

describe('fresh subscription timing', () => {
  it('preserves UTC and source-zone instants independently of the interpretation zone', () => {
    const text = feed(
      vevent(
        'DTSTART;TZID=America/New_York:20261024T090000\r\nDTEND;TZID=America/New_York:20261024T100000',
      ),
    );
    expect(subscriptionBusyIntervals(text, body, window)).toEqual([
      { start: Date.parse('2026-10-24T13:00Z'), end: Date.parse('2026-10-24T14:00Z') },
    ]);
    expect(
      subscriptionBusyIntervals(
        feed(vevent('DTSTART:20261024T090000Z\r\nDTEND:20261024T100000Z')),
        body,
        window,
      )[0].start,
    ).toBe(Date.parse('2026-10-24T09:00Z'));
  });

  it('interprets floating times explicitly and all-day DTEND exclusively across DST', () => {
    expect(
      subscriptionBusyIntervals(
        feed(vevent('DTSTART:20261024T090000\r\nDTEND:20261024T100000')),
        body,
        window,
      )[0].start,
    ).toBe(Date.parse('2026-10-24T08:00Z'));
    const intervals = subscriptionBusyIntervals(
      feed(vevent('DTSTART;VALUE=DATE:20261024\r\nDTEND;VALUE=DATE:20261026')),
      body,
      window,
    );
    expect(intervals).toEqual([
      { start: Date.parse('2026-10-23T23:00Z'), end: Date.parse('2026-10-26T00:00Z') },
    ]);
  });

  it('expands recurrence with EXDATE and moved overrides across daylight saving', () => {
    const text = feed(
      `${vevent('DTSTART;TZID=Europe/London:20261024T090000\r\nDTEND;TZID=Europe/London:20261024T100000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE;TZID=Europe/London:20261025T090000')}\r\n${vevent('RECURRENCE-ID;TZID=Europe/London:20261026T090000\r\nDTSTART;TZID=Europe/London:20261026T110000\r\nDTEND;TZID=Europe/London:20261026T120000')}`,
    );
    expect(
      subscriptionBusyIntervals(text, body, window).map((busy) =>
        new Date(busy.start).toISOString(),
      ),
    ).toEqual(['2026-10-24T08:00:00.000Z', '2026-10-26T11:00:00.000Z']);
  });

  it('includes a subscription event already ongoing at the start of the range', () => {
    expect(
      subscriptionBusyIntervals(
        feed(vevent('DTSTART:20261023T210000Z\r\nDTEND:20261024T020000Z')),
        body,
        window,
      ),
    ).toEqual([{ start: Date.parse('2026-10-23T21:00Z'), end: Date.parse('2026-10-24T02:00Z') }]);
  });

  it('rejects nominal day and week durations before recurrence can omit an autumn DST busy hour', () => {
    for (const duration of ['P1D', 'P1W', 'P1DT2H']) {
      const text = feed(
        vevent(
          `DTSTART;TZID=Europe/London:20261024T120000\r\nDURATION:${duration}\r\nRRULE:FREQ=DAILY;COUNT=2`,
        ),
      );
      expect(() => subscriptionBusyIntervals(text, body, window)).toThrow();
    }
  });

  it('preserves exact elapsed durations across an autumn DST recurrence', () => {
    const text = feed(
      vevent(
        'DTSTART;TZID=Europe/London:20261024T120000\r\nDURATION:PT24H\r\nRRULE:FREQ=DAILY;COUNT=2',
      ),
    );
    expect(subscriptionBusyIntervals(text, body, window)).toEqual([
      { start: Date.parse('2026-10-24T11:00:00Z'), end: Date.parse('2026-10-25T11:00:00Z') },
      { start: Date.parse('2026-10-25T12:00:00Z'), end: Date.parse('2026-10-26T12:00:00Z') },
    ]);
  });

  it('preserves positive elapsed hours, minutes, seconds and the VALUE parameter', () => {
    for (const [property, seconds] of [
      ['DURATION:PT1H30M45S', 5445],
      ['DURATION;VALUE=DURATION:+PT90M', 5400],
      ['DURATION:PT45S', 45],
    ]) {
      const start = Date.parse('2026-10-24T12:00:00Z');
      expect(
        subscriptionBusyIntervals(
          feed(vevent(`DTSTART:20261024T120000Z\r\n${property}`)),
          body,
          window,
        ),
      ).toEqual([{ start, end: start + Number(seconds) * 1000 }]);
    }
  });

  it('rejects malformed duration properties before the parser can log private feed content', () => {
    // Observe the dependency's real logging side effect; do not stub parsing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const property of [
        'DURATION:SYNTHETIC_PRIVATE_MARKER',
        'DURATION;VALUE=DURATION:SYNTHETIC_PRIVATE_MARKER',
        'DURATION:SYNTHETIC_PRIVATE_\r\n MARKER',
        'DURATION:PT1MSYNTHETIC_PRIVATE_MARKER',
        'DURATION;X-SOURCE="https://example.invalid/private":SYNTHETIC_PRIVATE_MARKER',
        'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDURATION:SYNTHETIC_PRIVATE_MARKER\r\nEND:VALARM',
        'DURATION:PT',
        'DURATION:PT0S',
        'DURATION:-PT1H',
        'DURATION:PT721H',
      ]) {
        const text = feed(vevent(`DTSTART;TZID=Europe/London:20261024T120000\r\n${property}`));
        expect(() => subscriptionBusyIntervals(text, body, window)).toThrow();
      }
      expect(warn).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('does not mark transparent or cancelled events busy', () => {
    for (const field of ['TRANSP:TRANSPARENT', 'STATUS:CANCELLED']) {
      expect(
        subscriptionBusyIntervals(
          feed(vevent(`DTSTART:20261024T090000Z\r\nDTEND:20261024T100000Z\r\n${field}`)),
          body,
          window,
        ),
      ).toEqual([]);
    }
  });

  it('expands recurring date-only events using each actual local day length', () => {
    const intervals = subscriptionBusyIntervals(
      feed(
        vevent(
          'DTSTART;VALUE=DATE:20261024\r\nDTEND;VALUE=DATE:20261025\r\nRRULE:FREQ=DAILY;COUNT=3',
        ),
      ),
      body,
      window,
    );
    expect(intervals.map((busy) => busy.end - busy.start)).toEqual([
      24 * 3600000,
      25 * 3600000,
      24 * 3600000,
    ]);
  });

  it('refuses unknown, incomplete, dense, ambiguous or unsupported feed timing', () => {
    for (const text of [
      'not a calendar',
      feed(
        `BEGIN:UNKNOWN\r\n${vevent('DTSTART:20261024T090000Z\r\nDTEND:20261024T100000Z')}\r\nEND:UNKNOWN`,
      ),
      feed('BEGIN:VFREEBUSY\r\nFREEBUSY:20261024T090000Z/20261024T100000Z\r\nEND:VFREEBUSY'),
      feed(vevent('DTSTART:20261024T990000Z\r\nDTEND:20261024T100000Z')),
      feed(vevent('DTSTART;TZID=Unknown/Zone:20261024T090000\r\nDTEND:20261024T100000Z')),
      feed(vevent('DTSTART:20261025T013000\r\nDTEND:20261025T023000')),
      feed(vevent('DTSTART:20261024T090000Z\r\nDTEND:20261024T100000Z\r\nRRULE:FREQ=SECONDLY')),
      feed(vevent('DTSTART:20261024T090000Z\r\nDTEND:20261024T100000Z\r\nRDATE:20261025T090000Z')),
      feed(
        Array.from({ length: 1001 }, () =>
          vevent('DTSTART:20261024T090000Z\r\nDTEND:20261024T100000Z'),
        ).join('\r\n'),
      ),
    ])
      expect(() => subscriptionBusyIntervals(text, body, window)).toThrow();
  });
});

describe('authenticated availability read', () => {
  const env = /** @type {any} */ ({ CALENDAR_SUBSCRIPTION_ALLOWLIST: 'calendar.google.com' });
  const calendar = {
    id: calendarId,
    subscriptionUrl: 'https://calendar.google.com/private/feed.ics',
    subscriptionSyncedAt: '2020-01-01',
    subscriptionError: 'Old sync failed',
  };
  const sqlFor = (rows) =>
    /** @type {any} */ (vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([]));

  it('rejects unowned calendars without fetching their URLs', async () => {
    const request = vi.fn();
    const response = await calendarAvailability(sqlFor([]), 'owner', body, env, request);
    expect(response.status).toBe(404);
    expect(request).not.toHaveBeenCalled();
  });

  it('uses only server-resolved, currently allowlisted URLs and exposes cached staleness separately', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      body: new TextEncoder().encode(
        feed(vevent('DTSTART:20261024T090000Z\r\nDTEND:20261024T100000Z')),
      ),
    });
    const sql = sqlFor([calendar]);
    const response = await calendarAvailability(
      sql,
      'owner',
      { ...body, url: 'https://evil.invalid/' },
      env,
      request,
    );
    const result = await response.json();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(result.complete).toBe(true);
    expect(result.sources[0]).toMatchObject({
      subscriptionSyncedAt: '2020-01-01',
      cachedSyncFailed: true,
      complete: true,
    });
    expect(request).toHaveBeenCalledWith(
      calendar.subscriptionUrl,
      expect.objectContaining({ timeoutMs: 10000, maxResponseBytes: 5 * 1024 * 1024 }),
    );
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('Private meeting');
    const query = sql.mock.calls[0];
    expect(query[0].join('?')).toContain('WHERE user_id =');
    expect(query.slice(1)).toEqual(['owner', [calendarId]]);
  });

  it('returns no busy data or suggestions if any calendar fails, without leaking feed errors', async () => {
    const request = vi.fn().mockRejectedValue(new Error('secret URL and private event'));
    const sql = sqlFor([{ id: otherId }, calendar]);
    const response = await calendarAvailability(
      sql,
      'owner',
      { ...body, calendarIds: [otherId, calendarId] },
      env,
      request,
    );
    const result = await response.json();
    expect(result.complete).toBe(false);
    expect(result.busy).toEqual([]);
    expect(result.sources.some((source) => !source.complete)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('fails closed when a feed redirects or a stored URL is no longer allowed', async () => {
    const request = vi.fn().mockResolvedValue({ status: 302, body: new Uint8Array() });
    const result = await (
      await calendarAvailability(sqlFor([calendar]), 'owner', body, env, request)
    ).json();
    expect(result.complete).toBe(false);
    request.mockClear();
    const disallowed = await (
      await calendarAvailability(
        sqlFor([{ ...calendar, subscriptionUrl: 'https://unknown.invalid/feed' }]),
        'owner',
        body,
        env,
        request,
      )
    ).json();
    expect(disallowed.complete).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('marks a nominal-duration feed incomplete instead of returning misleading busy intervals', async () => {
    for (const duration of ['P1D', 'P1W', 'P1DT2H']) {
      const request = vi.fn().mockResolvedValue({
        status: 200,
        body: new TextEncoder().encode(
          feed(
            vevent(
              `DTSTART;TZID=Europe/London:20261024T120000\r\nDURATION:${duration}\r\nRRULE:FREQ=DAILY;COUNT=2`,
            ),
          ),
        ),
      });
      const response = await calendarAvailability(sqlFor([calendar]), 'owner', body, env, request);
      const result = await response.json();
      expect(result.complete).toBe(false);
      expect(result.busy).toEqual([]);
      expect(result.sources[0].complete).toBe(false);
    }
  });

  it('enforces the request quota before calendar reads', async () => {
    allowRequest.mockResolvedValue(false);
    const sql = sqlFor([]);
    expect((await calendarAvailability(sql, 'owner', body, env)).status).toBe(429);
    expect(sql).not.toHaveBeenCalled();
  });
});
