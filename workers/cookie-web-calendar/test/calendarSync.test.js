// Ported from Cookie-Web's api/__tests__/calendarSync.test.js, unchanged —
// the injected request seam makes the suite runtime-agnostic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  calendarSubscriptionAllowlist,
  syncCalendarSubscription,
  validSubscriptionUrl,
} from '../src/calendarSync.js';

// Injected into syncCalendarSubscription in place of the real safe-https
// boundary, so each test scripts the feed response directly.
const requestPublicHttps = vi.fn();

const httpsResponse = (body = '', status = 200, headers = {}) => ({
  body: new TextEncoder().encode(body),
  headers,
  status,
});

// Allow test fixtures to use arbitrary hosts without coupling tests to the
// production default allowlist.
const TEST_ALLOWLIST = ['example.com'];

describe('validSubscriptionUrl', () => {
  it('accepts a well-formed https URL', () => {
    expect(validSubscriptionUrl('https://example.com/feed.ics', TEST_ALLOWLIST)).toBe(
      'https://example.com/feed.ics',
    );
  });

  it('accepts webcal URLs, normalized to their https equivalent', () => {
    expect(validSubscriptionUrl('webcal://example.com/feed.ics', TEST_ALLOWLIST)).toBe(
      'https://example.com/feed.ics',
    );
    expect(validSubscriptionUrl('WEBCAL://example.com/feed.ics', TEST_ALLOWLIST)).toBe(
      'https://example.com/feed.ics',
    );
    expect(
      validSubscriptionUrl('webcal://example.com:8443/a/feed.ics?token=x', TEST_ALLOWLIST),
    ).toBe('https://example.com:8443/a/feed.ics?token=x');
  });

  it('rewrites Google Calendar "add this calendar" share links to the public ICS feed', () => {
    // cid is the base64 calendar id; this one decodes to a plain gmail address.
    expect(
      validSubscriptionUrl(
        'https://calendar.google.com/calendar/u/0?cid=YWxsaXN0ZXJhYWxsQGdtYWlsLmNvbQ',
      ),
    ).toBe('https://calendar.google.com/calendar/ical/allisteraall%40gmail.com/public/basic.ics');
    // URL-safe base64 and ids containing '#' (holiday calendars) are encoded for the path.
    expect(
      validSubscriptionUrl(
        'https://calendar.google.com/calendar/u/0/r?cid=ZW4udWsjaG9saWRheUBncm91cC52LmNhbGVuZGFyLmdvb2dsZS5jb20',
      ),
    ).toBe(
      'https://calendar.google.com/calendar/ical/en.uk%23holiday%40group.v.calendar.google.com/public/basic.ics',
    );
    expect(
      validSubscriptionUrl('https://www.google.com/calendar/render?cid=YWJjQGV4YW1wbGUuY29t'),
    ).toBe('https://calendar.google.com/calendar/ical/abc%40example.com/public/basic.ics');
  });

  it('leaves ICS feed URLs alone even when they carry a cid parameter', () => {
    const feed = 'https://calendar.google.com/calendar/ical/a%40b.com/private-abc/basic.ics?cid=x';
    expect(validSubscriptionUrl(feed)).toBe(feed);
  });

  it('rejects Google share links whose cid is not a calendar id', () => {
    expect(validSubscriptionUrl('https://calendar.google.com/calendar/u/0?cid=')).toBeNull();
    expect(validSubscriptionUrl('https://calendar.google.com/calendar/u/0?cid=%%%')).toBeNull();
    // Decodes to control characters, not an address.
    expect(validSubscriptionUrl('https://calendar.google.com/calendar/u/0?cid=AAEC')).toBeNull();
  });

  it('rejects non-https URLs', () => {
    expect(validSubscriptionUrl('http://example.com/feed.ics', TEST_ALLOWLIST)).toBeNull();
    expect(validSubscriptionUrl('file:///etc/passwd', TEST_ALLOWLIST)).toBeNull();
    expect(validSubscriptionUrl('gopher://example.com', TEST_ALLOWLIST)).toBeNull();
    // Only a leading scheme is rewritten — webcal elsewhere is not a scheme.
    expect(
      validSubscriptionUrl('http://evil.example/webcal://example.com', TEST_ALLOWLIST),
    ).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(validSubscriptionUrl('not a url', TEST_ALLOWLIST)).toBeNull();
    expect(validSubscriptionUrl('', TEST_ALLOWLIST)).toBeNull();
    expect(validSubscriptionUrl(null, TEST_ALLOWLIST)).toBeNull();
    expect(validSubscriptionUrl(123, TEST_ALLOWLIST)).toBeNull();
    expect(
      validSubscriptionUrl('https://example.com/' + 'a'.repeat(2000), TEST_ALLOWLIST),
    ).toBeNull();
  });

  // The egress boundary rejects these too, but only at sync time — validating
  // here keeps a credential-bearing URL from being stored as a calendar whose
  // every sync then fails.
  it('rejects URLs carrying embedded credentials', () => {
    expect(
      validSubscriptionUrl('https://user:pass@example.com/feed.ics', TEST_ALLOWLIST),
    ).toBeNull();
    expect(validSubscriptionUrl('https://user@example.com/feed.ics', TEST_ALLOWLIST)).toBeNull();
    expect(
      validSubscriptionUrl('webcal://user:pass@example.com/feed.ics', TEST_ALLOWLIST),
    ).toBeNull();
  });

  it('rejects hosts outside the configured allowlist', () => {
    expect(validSubscriptionUrl('https://evil.com/feed.ics', TEST_ALLOWLIST)).toBeNull();
  });

  it.each(['https', 'webcal', 'WEBCAL'])(
    'accepts arbitrary feed hosts using %s by default',
    (scheme) => {
      expect(validSubscriptionUrl(`${scheme}://club.example/fixtures.ics?team=1`)).toBe(
        'https://club.example/fixtures.ics?team=1',
      );
    },
  );

  it('uses an optional operator allowlist for both HTTPS and webcal links', () => {
    expect(calendarSubscriptionAllowlist({})).toEqual([]);
    expect(calendarSubscriptionAllowlist({ CALENDAR_SUBSCRIPTION_ALLOWLIST: ' ' })).toEqual([]);
    const allowlist = calendarSubscriptionAllowlist({
      CALENDAR_SUBSCRIPTION_ALLOWLIST: ' Calendar.Google.com, club.example ',
    });
    expect(allowlist).toEqual(['calendar.google.com', 'club.example']);
    expect(validSubscriptionUrl('webcal://feeds.club.example/feed.ics', allowlist)).toBe(
      'https://feeds.club.example/feed.ics',
    );
    expect(validSubscriptionUrl('webcal://other.example/feed.ics', allowlist)).toBeNull();
    expect(validSubscriptionUrl('https://notclub.example/feed.ics', allowlist)).toBeNull();
  });
});

// A minimal stand-in for the postgres.js sql tagged-template + sql.begin,
// scripted with queued results the same way the other _lib tests are.
function makeSql(queue) {
  /** @type {any} */
  /** @type {any} */ const run = () => Promise.resolve(queue.shift() ?? []);
  run.begin = async (fn) => fn(run);
  return run;
}

describe('syncCalendarSubscription', () => {
  beforeEach(() => {
    vi.mocked(requestPublicHttps).mockResolvedValue(
      httpsResponse('BEGIN:VCALENDAR\nEND:VCALENDAR'),
    );
  });
  afterEach(() => {
    vi.mocked(requestPublicHttps).mockReset();
  });

  it('refuses to fetch a URL that resolves to a private IP (SSRF guard)', async () => {
    vi.mocked(requestPublicHttps).mockRejectedValue(
      new Error('The remote URL points to a disallowed address'),
    );
    const sql = makeSql([]);

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://internal.example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Could not sync the calendar subscription');
  });

  it('refuses link-local and cloud-metadata-range addresses', async () => {
    vi.mocked(requestPublicHttps).mockRejectedValue(
      new Error('The remote URL points to a disallowed address'),
    );
    const sql = makeSql([]);

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://metadata.example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(false);
  });

  it('uses the pinned public-HTTPS boundary with response and timeout caps', async () => {
    const sql = makeSql([]);

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://rebind.example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(true);
    expect(requestPublicHttps).toHaveBeenCalledWith(
      'https://rebind.example.com/feed.ics',
      expect.objectContaining({ timeoutMs: 10_000, maxResponseBytes: 5 * 1024 * 1024 }),
    );
  });

  it('does not follow redirects', async () => {
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse('', 302, { location: '/other' }));
    const sql = makeSql([]);

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Could not sync the calendar subscription');
  });

  it('records the error on the calendar row without touching events when fetch fails', async () => {
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse('', 500));
    const queue = [[]];
    const sql = makeSql(queue);

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Could not sync the calendar subscription');
  });

  // subscription_error is rendered by the sidebar, so it must not echo raw,
  // remote-controlled feed content back to the client. The detail is logged
  // internally and capped, while the stored/client-facing message is generic.
  it('stores a generic sync failure message without echoing remote content', async () => {
    vi.mocked(requestPublicHttps).mockRejectedValue(new Error('x'.repeat(5000)));
    const stored = [];
    /** @type {any} */ const sql = (_strings, ...values) => {
      stored.push(values);
      return Promise.resolve([]);
    };
    sql.begin = async (fn) => fn(sql);

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Could not sync the calendar subscription');
    expect(stored[0][0]).toBe('Could not sync the calendar subscription');
  });

  it('parses events (including an expanded RRULE series) and replaces the calendar contents', async () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const dtstamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}T000000Z`;
    const dtstart = `${soon.getUTCFullYear()}${String(soon.getUTCMonth() + 1).padStart(2, '0')}${String(soon.getUTCDate()).padStart(2, '0')}T140000Z`;
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:1@example.com',
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${dtstart}`,
      `DTEND:${dtstart}`,
      'SUMMARY:Standup',
      'RRULE:FREQ=DAILY;COUNT=3',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse(ics));

    const inserted = [];
    const queue = [];
    /** @type {any} */ const sql = (strings, ...values) => {
      const text = strings.join('?');
      if (text.includes('json_to_recordset')) {
        // Regression guard: the ::json parameter must be the raw JS array,
        // not a pre-stringified string — see the comment above this query in
        // calendarSync.js for why postgres.js double-encodes the latter into
        // a scalar that json_to_recordset then rejects (COOKIE-WEB-C).
        const jsonValue = values.find((value) => Array.isArray(value));
        inserted.push(jsonValue);
      }
      return Promise.resolve(queue.shift() ?? []);
    };
    sql.begin = async (fn) => fn(sql);

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    expect(inserted[0]).toHaveLength(3);
    expect(inserted[0][0].title).toBe('Standup');
  });

  function captureInsertedRows() {
    const inserted = [];
    /** @type {any} */ const sql = (strings, ...values) => {
      const text = strings.join('?');
      if (text.includes('json_to_recordset')) {
        inserted.push(values.find((value) => Array.isArray(value)));
      }
      return Promise.resolve([]);
    };
    sql.begin = async (fn) => fn(sql);
    return { sql, inserted };
  }

  it('honours EXDATE, moved RECURRENCE-ID instances and cancelled instances', async () => {
    const year = new Date().getUTCFullYear() + 1;
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:series@example.com',
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${year}0302T090000Z`,
      `DTEND:${year}0302T100000Z`,
      'SUMMARY:Standup',
      'RRULE:FREQ=DAILY;COUNT=5',
      `EXDATE:${year}0303T090000Z`,
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:series@example.com',
      'DTSTAMP:20260101T000000Z',
      `RECURRENCE-ID:${year}0304T090000Z`,
      `DTSTART:${year}0304T150000Z`,
      `DTEND:${year}0304T153000Z`,
      'SUMMARY:Standup',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:series@example.com',
      'DTSTAMP:20260101T000000Z',
      `RECURRENCE-ID:${year}0305T090000Z`,
      `DTSTART:${year}0305T090000Z`,
      `DTEND:${year}0305T100000Z`,
      'SUMMARY:Standup',
      'STATUS:CANCELLED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse(ics));
    const { sql, inserted } = captureInsertedRows();

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(true);
    expect(
      inserted[0].map((row) => ({ date: row.date, start: row.start, duration: row.duration })),
    ).toEqual([
      { date: `${year}-03-02`, start: '09:00', duration: 60 },
      { date: `${year}-03-04`, start: '15:00', duration: 30 },
      { date: `${year}-03-06`, start: '09:00', duration: 60 },
    ]);
  });

  it('skips a cancelled single event', async () => {
    const year = new Date().getUTCFullYear() + 1;
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:cancelled@example.com',
      'DTSTAMP:20260101T000000Z',
      `DTSTART:${year}0302T090000Z`,
      `DTEND:${year}0302T100000Z`,
      'SUMMARY:Cancelled meeting',
      'STATUS:CANCELLED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse(ics));
    const { sql } = captureInsertedRows();

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result).toEqual({ ok: true, count: 0 });
  });

  it('keeps TZID event wall times across daylight-saving offsets', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:winter@example.com',
      'DTSTART;TZID=Europe/London:20260115T090000',
      'DTEND;TZID=Europe/London:20260115T100000',
      'SUMMARY:Winter meeting',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:summer@example.com',
      'DTSTART;TZID=Europe/London:20260715T090000',
      'DTEND;TZID=Europe/London:20260715T100000',
      'SUMMARY:Summer meeting',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse(ics));
    const { sql, inserted } = captureInsertedRows();

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(true);
    expect(inserted[0].map(({ date, start }) => ({ date, start }))).toEqual([
      { date: '2026-01-15', start: '09:00' },
      { date: '2026-07-15', start: '09:00' },
    ]);
  });

  it('renders a single-day all-day event as one all_day row, not a ~24h timed block', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:holiday@example.com',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260801',
      'DTEND;VALUE=DATE:20260802',
      'SUMMARY:Company Holiday',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse(ics));
    const { sql, inserted } = captureInsertedRows();

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(true);
    expect(inserted[0]).toEqual([
      {
        title: 'Company Holiday',
        description: null,
        location: null,
        date: '2026-08-01',
        start: '00:00',
        duration: 1440,
        all_day: true,
      },
    ]);
  });

  it('expands a multi-day all-day event into one row per day it spans (exclusive DTEND)', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:trip@example.com',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260810',
      'DTEND;VALUE=DATE:20260813',
      'SUMMARY:Multi-day trip',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse(ics));
    const { sql, inserted } = captureInsertedRows();

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(true);
    expect(inserted[0].map((row) => row.date)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
    expect(inserted[0].every((row) => row.all_day && row.duration === 1440)).toBe(true);
  });

  it('expands a recurring all-day event across occurrences', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:anniversary@example.com',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260101',
      'DTEND;VALUE=DATE:20260102',
      'SUMMARY:Yearly Holiday',
      'RRULE:FREQ=YEARLY;COUNT=3',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse(ics));
    const { sql, inserted } = captureInsertedRows();

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(true);
    expect(inserted[0].map((row) => row.date)).toEqual(['2026-01-01', '2027-01-01', '2028-01-01']);
  });

  it('recovers the correct calendar date for an all-day event regardless of server timezone', async () => {
    const nodeProcess = /** @type {any} */ (globalThis).process;
    const originalTz = nodeProcess.env.TZ;
    nodeProcess.env.TZ = 'Pacific/Kiritimati'; // UTC+14 — the timezone most likely to expose a UTC-based off-by-one
    try {
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:holiday@example.com',
        'DTSTAMP:20260101T000000Z',
        'DTSTART;VALUE=DATE:20260801',
        'DTEND;VALUE=DATE:20260802',
        'SUMMARY:Company Holiday',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
      vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse(ics));
      const { sql, inserted } = captureInsertedRows();

      const result = await syncCalendarSubscription(
        sql,
        'cal-1',
        'user-1',
        'https://example.com/feed.ics',
        requestPublicHttps,
      );

      expect(result.ok).toBe(true);
      expect(inserted[0][0].date).toBe('2026-08-01');
    } finally {
      nodeProcess.env.TZ = originalTz;
    }
  });

  it('bounds work for many attacker-sized all-day spans before output caps apply', async () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      [
        'BEGIN:VEVENT',
        `UID:oversized-${index}@example.com`,
        'DTSTAMP:20260101T000000Z',
        'DTSTART;VALUE=DATE:90000101',
        'DTEND;VALUE=DATE:99991231',
        `SUMMARY:Oversized ${index}`,
        'END:VEVENT',
      ].join('\r\n'),
    );
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse(ics));
    const { sql } = captureInsertedRows();

    const started = performance.now();
    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  /** @param {Date} date */
  const icsDate = (date) =>
    `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function captureSyncQueries() {
    const inserted = [];
    const updates = [];
    /** @type {any} */ const sql = (strings, ...values) => {
      const text = strings.join('?');
      if (text.includes('json_to_recordset')) {
        inserted.push(values.find((value) => Array.isArray(value)));
      }
      if (text.includes('UPDATE calendars')) updates.push({ text, values });
      return Promise.resolve([]);
    };
    sql.begin = async (fn) => fn(sql);
    return { sql, inserted, updates };
  }

  it('still imports future occurrences of a daily series that began over a year ago', async () => {
    const start = icsDate(new Date(Date.now() - 800 * DAY_MS));
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:daily@example.com',
      'DTSTAMP:20200101T000000Z',
      `DTSTART:${start}T090000Z`,
      `DTEND:${start}T093000Z`,
      'SUMMARY:Daily standup',
      'RRULE:FREQ=DAILY',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse(ics));
    const { sql, inserted, updates } = captureSyncQueries();

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    const today = new Date().toISOString().slice(0, 10);
    const dates = inserted[0].map((row) => row.date);
    expect(result.ok).toBe(true);
    // The whole past year, plus the future up to its own per-event cap.
    // (Today's 09:00 falls on either side of "now" depending on the clock.)
    expect(dates.filter((date) => date < today).length).toBeGreaterThanOrEqual(364);
    expect(dates.filter((date) => date > today).length).toBeGreaterThanOrEqual(365);
    expect(new Set(dates).size).toBe(dates.length);
    // The future was cut at its cap, so the sync says so instead of
    // reporting a clean import.
    expect(result.truncated).toBe(true);
    expect(updates.at(-1).values[0]).toMatch(/not imported/);
  });

  it('keeps future events of a feed whose history exceeds the per-sync cap, and flags it', async () => {
    const past = Array.from({ length: 1200 }, (_, index) => {
      const day = icsDate(new Date(Date.now() - (1 + (index % 300)) * DAY_MS));
      return [
        'BEGIN:VEVENT',
        `UID:past-${index}@example.com`,
        'DTSTAMP:20200101T000000Z',
        `DTSTART:${day}T090000Z`,
        `DTEND:${day}T100000Z`,
        `SUMMARY:Past ${index}`,
        'END:VEVENT',
      ].join('\r\n');
    });
    const upcoming = icsDate(new Date(Date.now() + 10 * DAY_MS));
    const future = [
      'BEGIN:VEVENT',
      'UID:future@example.com',
      'DTSTAMP:20200101T000000Z',
      `DTSTART:${upcoming}T090000Z`,
      `DTEND:${upcoming}T100000Z`,
      'SUMMARY:Upcoming',
      'END:VEVENT',
    ].join('\r\n');
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...past, future, 'END:VCALENDAR'].join('\r\n');
    vi.mocked(requestPublicHttps).mockResolvedValue(httpsResponse(ics));
    const { sql, inserted, updates } = captureSyncQueries();

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(inserted[0].some((row) => row.title === 'Upcoming')).toBe(true);
    expect(inserted[0].filter((row) => row.title.startsWith('Past'))).toHaveLength(500);
    const update = updates.at(-1);
    expect(update.text).toContain('subscription_error =');
    expect(update.values[0]).toMatch(/not imported/);
  });

  it('clears subscription_error on a complete sync', async () => {
    const { sql, updates } = captureSyncQueries();

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result).toEqual({ ok: true, count: 0 });
    expect(updates.at(-1).values[0]).toBeNull();
  });

  it('catches a failure inside the replace transaction and records it as a sync error', async () => {
    vi.mocked(requestPublicHttps).mockResolvedValue(
      httpsResponse('BEGIN:VCALENDAR\nEND:VCALENDAR'),
    );
    const updates = [];
    /** @type {any} */ const sql = (strings, ...values) => {
      updates.push({ text: strings.join('?'), values });
      return Promise.resolve([]);
    };
    sql.begin = async () => {
      throw new Error('cannot call json_to_recordset on a scalar');
    };

    const result = await syncCalendarSubscription(
      sql,
      'cal-1',
      'user-1',
      'https://example.com/feed.ics',
      requestPublicHttps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Could not sync the calendar subscription');
    expect(updates.some((update) => update.text.includes('subscription_error'))).toBe(true);
  });
});
