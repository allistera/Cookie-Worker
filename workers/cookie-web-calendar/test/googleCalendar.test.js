import { describe, expect, it, vi } from 'vitest';

import { encryptToken } from '../src/googleAuth.js';
import {
  GOOGLE_API_URL,
  addDays,
  authorizeGoogle,
  createGoogleEvent,
  deleteGoogleEvent,
  disconnectGoogle,
  getGoogleStatus,
  googleCalendarEntries,
  handleGoogleCallback,
  instantOf,
  listGoogleEvents,
  mapGoogleEvent,
  parseGoogleCalendarId,
  parseGoogleEventId,
  updateGoogleEvent,
  updateGoogleSelection,
  wallClock,
} from '../src/googleCalendar.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-9999-9999-999999999999';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32)));
const PRODUCTION = 'https://mail.infinitywave.online';
const env = /** @type {any} */ ({
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_TOKEN_ENCRYPTION_KEY: KEY,
  ALLOWED_ORIGIN: PRODUCTION,
  SENTRY_ENVIRONMENT: 'production',
});

const WORK = {
  id: 'work@group.calendar.google.com',
  name: 'Work',
  color: '#4285f4',
  primary: false,
  readOnly: false,
};
const PRIMARY = {
  id: 'person@example.com',
  name: 'Personal',
  color: '#9fe1e7',
  primary: true,
  readOnly: false,
};
const SHARED = {
  id: 'team@group.calendar.google.com',
  name: 'Team',
  color: '#f6bf26',
  primary: false,
  readOnly: true,
};

/** @param {unknown} body @param {number} [status] */
const jsonResponse = (body, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * A connected row as loadConnection returns it, with a cached access token
 * that stays valid for the whole test so no refresh happens.
 *
 * @param {Partial<Record<string, unknown>>} [overrides]
 */
async function connectionRow(overrides = {}) {
  return {
    userId: USER_ID,
    email: 'person@example.com',
    refreshTokenEncrypted: await encryptToken('refresh-1', KEY),
    accessTokenEncrypted: await encryptToken('access-1', KEY),
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    selectedCalendars: [PRIMARY, WORK],
    needsReauth: false,
    ...overrides,
  };
}

/**
 * Routes Google API calls by method + path to canned responses; anything else
 * fails the test loudly.
 *
 * @param {Record<string, (url: URL, init: RequestInit) => Response | Promise<Response>>} routes keyed `METHOD path`
 */
function googleFetch(routes) {
  return vi.fn(async (/** @type {any} */ input, /** @type {any} */ init = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? 'GET'} ${url.pathname.replace('/calendar/v3', '')}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected Google request: ${key}`);
    return handler(url, init);
  });
}

describe('ids', () => {
  it('splits event ids on the last colon and rejects malformed ones', () => {
    expect(
      parseGoogleEventId('google:work@group.calendar.google.com:abc_20261010T090000Z'),
    ).toEqual({
      calendarId: 'work@group.calendar.google.com',
      eventId: 'abc_20261010T090000Z',
    });
    expect(parseGoogleEventId('google:onlycalendar')).toBeNull();
    expect(parseGoogleEventId('google::event')).toBeNull();
    expect(parseGoogleEventId('google:cal:')).toBeNull();
    expect(parseGoogleEventId('11111111-1111-1111-1111-111111111111')).toBeNull();
    expect(parseGoogleCalendarId('google:person@example.com')).toBe('person@example.com');
    expect(parseGoogleCalendarId('google:')).toBeNull();
    expect(parseGoogleCalendarId('work')).toBeNull();
  });
});

describe('time zones', () => {
  it('reads a wall clock in the requested zone, including across DST', () => {
    expect(wallClock(Date.parse('2026-07-01T12:00:00Z'), 'Europe/London')).toMatchObject({
      date: '2026-07-01',
      time: '13:00',
    });
    expect(wallClock(Date.parse('2026-12-01T12:00:00Z'), 'Europe/London')).toMatchObject({
      date: '2026-12-01',
      time: '12:00',
    });
    expect(wallClock(Date.parse('2026-07-01T23:30:00Z'), 'Asia/Tokyo')).toMatchObject({
      date: '2026-07-02',
      time: '08:30',
    });
  });

  it('finds the instant a zone shows a wall-clock time, either side of a DST change', () => {
    expect(instantOf('2026-07-01', '13:00', 'Europe/London').toISOString()).toBe(
      '2026-07-01T12:00:00.000Z',
    );
    expect(instantOf('2026-12-01', '12:00', 'Europe/London').toISOString()).toBe(
      '2026-12-01T12:00:00.000Z',
    );
    // Clocks go forward at 01:00 UTC on 2026-03-29: 02:30 local is 01:30 UTC.
    expect(instantOf('2026-03-29', '02:30', 'Europe/London').toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    expect(instantOf('2026-10-10', '00:00', 'UTC').toISOString()).toBe('2026-10-10T00:00:00.000Z');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('mapGoogleEvent', () => {
  it('maps a timed event into the caller zone with a Google-prefixed id', () => {
    const [event] = mapGoogleEvent(
      {
        id: 'evt1',
        summary: '  Standup ',
        description: 'Daily',
        location: 'Room 1',
        htmlLink: 'https://www.google.com/calendar/event?eid=x',
        recurringEventId: 'series',
        start: { dateTime: '2026-10-10T09:00:00+01:00' },
        end: { dateTime: '2026-10-10T09:45:00+01:00' },
      },
      WORK,
      'Europe/London',
      null,
    );
    expect(event).toMatchObject({
      id: 'google:work@group.calendar.google.com:evt1',
      seriesId: 'google:work@group.calendar.google.com:evt1',
      title: 'Standup',
      description: 'Daily',
      location: 'Room 1',
      date: '2026-10-10',
      start: '09:00',
      duration: 45,
      calendar: 'google:work@group.calendar.google.com',
      allDay: false,
      tone: null,
      recurrenceRule: null,
      source: 'google',
      googleCalendarId: WORK.id,
      googleEventId: 'evt1',
      recurring: true,
      readOnly: false,
      htmlLink: 'https://www.google.com/calendar/event?eid=x',
    });
  });

  it('expands a multi-day all-day event into one row per day inside the range', () => {
    const rows = mapGoogleEvent(
      {
        id: 'trip',
        summary: 'Offsite',
        start: { date: '2026-10-09' },
        end: { date: '2026-10-13' },
      },
      PRIMARY,
      'UTC',
      { from: '2026-10-10', to: '2026-10-11' },
    );
    expect(rows.map((row) => [row.id, row.date])).toEqual([
      ['google:person@example.com:trip@2026-10-10', '2026-10-10'],
      ['google:person@example.com:trip@2026-10-11', '2026-10-11'],
    ]);
    expect(rows[0]).toMatchObject({
      seriesId: 'google:person@example.com:trip',
      seriesDate: '2026-10-09',
      start: '00:00',
      duration: 1440,
      allDay: true,
    });
    const [single] = mapGoogleEvent(
      { id: 'day', summary: 'Holiday', start: { date: '2026-10-10' }, end: { date: '2026-10-11' } },
      PRIMARY,
      'UTC',
      null,
    );
    expect(single.id).toBe('google:person@example.com:day');
  });

  it('skips cancelled instances and defaults a missing title and end', () => {
    expect(mapGoogleEvent({ id: 'x', status: 'cancelled' }, WORK, 'UTC', null)).toEqual([]);
    expect(mapGoogleEvent(null, WORK, 'UTC', null)).toEqual([]);
    const [event] = mapGoogleEvent(
      { id: 'notitle', start: { dateTime: '2026-10-10T10:00:00Z' } },
      SHARED,
      'UTC',
      null,
    );
    expect(event).toMatchObject({ title: '(No title)', duration: 30, readOnly: true });
  });
});

describe('listGoogleEvents', () => {
  const range = { from: '2026-10-01', to: '2026-10-31' };

  it('is silent when not configured, not connected, or nothing is selected', async () => {
    expect(await listGoogleEvents(createMockSql(), USER_ID, range, 'UTC', {})).toEqual({
      events: [],
      error: null,
      truncated: false,
    });
    expect(await listGoogleEvents(createMockSql([[]]), USER_ID, range, 'UTC', env)).toEqual({
      events: [],
      error: null,
      truncated: false,
    });
    const none = await connectionRow({ selectedCalendars: [] });
    expect(await listGoogleEvents(createMockSql([[none]]), USER_ID, range, 'UTC', env)).toEqual({
      events: [],
      error: null,
      truncated: false,
    });
  });

  it('fetches each selected calendar in the window, in the caller zone, and merges them', async () => {
    const fetchImpl = googleFetch({
      [`GET /calendars/${encodeURIComponent(PRIMARY.id)}/events`]: (url) => {
        expect(url.searchParams.get('singleEvents')).toBe('true');
        expect(url.searchParams.get('orderBy')).toBe('startTime');
        expect(url.searchParams.get('timeZone')).toBe('Europe/London');
        expect(url.searchParams.get('timeMin')).toBe('2026-09-30T23:00:00.000Z');
        // Clocks went back on 2026-10-25, so the exclusive end is midnight GMT.
        expect(url.searchParams.get('timeMax')).toBe('2026-11-01T00:00:00.000Z');
        return jsonResponse({
          items: [
            {
              id: 'p1',
              summary: 'Dentist',
              start: { dateTime: '2026-10-05T14:00:00+01:00' },
              end: { dateTime: '2026-10-05T15:00:00+01:00' },
            },
          ],
        });
      },
      [`GET /calendars/${encodeURIComponent(WORK.id)}/events`]: () =>
        jsonResponse({
          items: [
            {
              id: 'w1',
              summary: 'Planning',
              start: { dateTime: '2026-10-05T09:00:00+01:00' },
              end: { dateTime: '2026-10-05T10:30:00+01:00' },
            },
          ],
        }),
    });

    const result = await listGoogleEvents(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      range,
      'Europe/London',
      env,
      { fetchImpl },
    );

    expect(result.error).toBeNull();
    expect(result.events.map((event) => [event.title, event.start, event.duration])).toEqual([
      ['Dentist', '14:00', 60],
      ['Planning', '09:00', 90],
    ]);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer access-1');
  });

  it('follows pagination and narrows to one calendar when asked', async () => {
    let page = 0;
    const fetchImpl = googleFetch({
      [`GET /calendars/${encodeURIComponent(WORK.id)}/events`]: (url) => {
        page += 1;
        if (page === 1) {
          expect(url.searchParams.get('pageToken')).toBeNull();
          return jsonResponse({
            items: [
              {
                id: 'a',
                summary: 'A',
                start: { dateTime: '2026-10-05T09:00:00Z' },
                end: { dateTime: '2026-10-05T10:00:00Z' },
              },
            ],
            nextPageToken: 'page-2',
          });
        }
        expect(url.searchParams.get('pageToken')).toBe('page-2');
        return jsonResponse({
          items: [
            {
              id: 'b',
              summary: 'B',
              start: { dateTime: '2026-10-06T09:00:00Z' },
              end: { dateTime: '2026-10-06T10:00:00Z' },
            },
          ],
        });
      },
    });

    const result = await listGoogleEvents(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      range,
      'UTC',
      env,
      { fetchImpl, calendar: `google:${WORK.id}` },
    );
    expect(result.events.map((event) => event.title)).toEqual(['A', 'B']);
    expect(result.truncated).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    expect(
      await listGoogleEvents(createMockSql([[await connectionRow()]]), USER_ID, range, 'UTC', env, {
        fetchImpl,
        calendar: 'google:someone-else@example.com',
      }),
    ).toEqual({ events: [], error: null, truncated: false });
  });

  it('keeps the other calendars when one fails, and reports a lapsed grant, without throwing', async () => {
    const failing = googleFetch({
      [`GET /calendars/${encodeURIComponent(PRIMARY.id)}/events`]: () =>
        jsonResponse({ error: { message: 'Not Found' } }, 404),
      [`GET /calendars/${encodeURIComponent(WORK.id)}/events`]: () =>
        jsonResponse({
          items: [
            {
              id: 'w1',
              summary: 'Planning',
              start: { dateTime: '2026-10-05T09:00:00Z' },
              end: { dateTime: '2026-10-05T10:00:00Z' },
            },
          ],
        }),
    });
    const outage = await listGoogleEvents(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      range,
      'UTC',
      env,
      { fetchImpl: failing },
    );
    expect(outage.events.map((event) => event.title)).toEqual(['Planning']);
    expect(outage.error).toBe('Events from the Google calendar "Personal" could not be loaded.');
    expect(outage.truncated).toBe(false);

    const alone = await listGoogleEvents(
      createMockSql([[await connectionRow({ selectedCalendars: [PRIMARY] })]]),
      USER_ID,
      range,
      'UTC',
      env,
      { fetchImpl: failing },
    );
    expect(alone).toEqual({
      events: [],
      error: 'Google Calendar events could not be loaded.',
      truncated: false,
    });

    const needsReauth = await connectionRow({ needsReauth: true });
    const lapsed = await listGoogleEvents(
      createMockSql([[needsReauth]]),
      USER_ID,
      range,
      'UTC',
      env,
    );
    expect(lapsed.error).toContain('reconnected');
  });

  it('refreshes once on a 401 and retries with the new token', async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async (/** @type {any} */ input, /** @type {any} */ init = {}) => {
      const url = new URL(input);
      if (url.hostname === 'oauth2.googleapis.com') {
        return jsonResponse({ access_token: 'access-2', expires_in: 3600 });
      }
      attempts += 1;
      if (attempts === 1) {
        expect(init.headers.Authorization).toBe('Bearer access-1');
        return jsonResponse({ error: { message: 'Invalid Credentials' } }, 401);
      }
      expect(init.headers.Authorization).toBe('Bearer access-2');
      return jsonResponse({ items: [] });
    });
    const sql = createMockSql([[await connectionRow({ selectedCalendars: [WORK] })], []]);
    const result = await listGoogleEvents(sql, USER_ID, range, 'UTC', env, { fetchImpl });
    expect(result).toEqual({ events: [], error: null, truncated: false });
    expect(attempts).toBe(2);
    expect(sql.calls[1].text).toContain('SET access_token_encrypted =');
  });
});

describe('listGoogleEvents truncation', () => {
  it('flags a window cut short by the page cap', async () => {
    const fetchImpl = googleFetch({
      [`GET /calendars/${encodeURIComponent(WORK.id)}/events`]: () =>
        jsonResponse({ items: [], nextPageToken: 'more' }),
    });
    const result = await listGoogleEvents(
      createMockSql([[await connectionRow({ selectedCalendars: [WORK] })]]),
      USER_ID,
      { from: '2026-10-01', to: '2026-10-31' },
      'UTC',
      env,
      { fetchImpl },
    );
    expect(result.truncated).toBe(true);
    expect(result.error).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe('googleCalendarEntries', () => {
  it('shapes the selected calendars like /calendars rows', async () => {
    expect(googleCalendarEntries(null)).toEqual([]);
    const connection = /** @type {any} */ (await connectionRow({ selectedCalendars: [SHARED] }));
    expect(googleCalendarEntries(connection)).toEqual([
      {
        id: `google:${SHARED.id}`,
        name: 'Team',
        color: '#f6bf26',
        source: 'google',
        googleCalendarId: SHARED.id,
        readOnly: true,
      },
    ]);
  });
});

const FIELDS = {
  title: 'Lunch',
  description: null,
  location: 'Cafe',
  date: '2026-10-10',
  start: '12:30',
  duration: 60,
  calendar: `google:${WORK.id}`,
  recurrenceRule: null,
};

describe('createGoogleEvent', () => {
  it('inserts a timed event with wall-clock times in the caller zone', async () => {
    const fetchImpl = googleFetch({
      [`POST /calendars/${encodeURIComponent(WORK.id)}/events`]: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
          summary: 'Lunch',
          location: 'Cafe',
          start: { dateTime: '2026-10-10T12:30:00', timeZone: 'Europe/London' },
          end: { dateTime: '2026-10-10T13:30:00', timeZone: 'Europe/London' },
        });
        return jsonResponse(
          {
            id: 'new1',
            summary: 'Lunch',
            location: 'Cafe',
            start: { dateTime: '2026-10-10T12:30:00+01:00' },
            end: { dateTime: '2026-10-10T13:30:00+01:00' },
          },
          200,
        );
      },
    });
    const response = await createGoogleEvent(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      FIELDS,
      'Europe/London',
      env,
      { fetchImpl },
    );
    expect(response.status).toBe(201);
    const { event } = await response.json();
    expect(event).toMatchObject({
      id: `google:${WORK.id}:new1`,
      date: '2026-10-10',
      start: '12:30',
      duration: 60,
    });
  });

  it('refuses repeats, unselected calendars, read-only calendars and an unconfigured deployment', async () => {
    const repeating = await createGoogleEvent(
      createMockSql(),
      USER_ID,
      { ...FIELDS, recurrenceRule: 'WEEKLY' },
      'UTC',
      env,
    );
    expect(repeating.status).toBe(400);

    const unselected = await createGoogleEvent(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      { ...FIELDS, calendar: 'google:other@example.com' },
      'UTC',
      env,
    );
    expect(unselected.status).toBe(404);

    const readOnly = await createGoogleEvent(
      createMockSql([[await connectionRow({ selectedCalendars: [SHARED] })]]),
      USER_ID,
      { ...FIELDS, calendar: `google:${SHARED.id}` },
      'UTC',
      env,
    );
    expect(readOnly.status).toBe(403);
    expect((await readOnly.json()).error).toContain('read-only');

    const unconfigured = await createGoogleEvent(createMockSql(), USER_ID, FIELDS, 'UTC', {});
    expect(unconfigured.status).toBe(503);
  });

  it('maps Google refusals and failures to 403 / 502', async () => {
    const forbidden = await createGoogleEvent(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      FIELDS,
      'UTC',
      env,
      {
        fetchImpl: googleFetch({
          [`POST /calendars/${encodeURIComponent(WORK.id)}/events`]: () =>
            jsonResponse({ error: { message: 'Forbidden' } }, 403),
        }),
      },
    );
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error).toContain('Forbidden');

    const broken = await createGoogleEvent(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      FIELDS,
      'UTC',
      env,
      {
        fetchImpl: googleFetch({
          [`POST /calendars/${encodeURIComponent(WORK.id)}/events`]: () => jsonResponse(null, 500),
        }),
      },
    );
    expect(broken.status).toBe(502);
  });
});

describe('updateGoogleEvent', () => {
  const ID = `google:${WORK.id}:evt1`;
  const existing = {
    id: 'evt1',
    summary: 'Old',
    description: 'keep me? no',
    attendees: [{ email: 'a@example.com' }],
    start: { dateTime: '2026-10-09T09:00:00+01:00' },
    end: { dateTime: '2026-10-09T09:30:00+01:00' },
  };

  it('fetches the event and puts it back with the new fields, keeping what Cookie does not edit', async () => {
    const fetchImpl = googleFetch({
      [`GET /calendars/${encodeURIComponent(WORK.id)}/events/evt1`]: () => jsonResponse(existing),
      [`PUT /calendars/${encodeURIComponent(WORK.id)}/events/evt1`]: (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.attendees).toEqual([{ email: 'a@example.com' }]);
        expect(body.summary).toBe('Lunch');
        expect(body.description).toBeUndefined();
        expect(body.start).toEqual({ dateTime: '2026-10-10T12:30:00', timeZone: 'UTC' });
        expect(body.end).toEqual({ dateTime: '2026-10-10T13:30:00', timeZone: 'UTC' });
        return jsonResponse({
          ...existing,
          summary: 'Lunch',
          start: { dateTime: '2026-10-10T12:30:00Z' },
          end: { dateTime: '2026-10-10T13:30:00Z' },
        });
      },
    });
    const response = await updateGoogleEvent(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      ID,
      FIELDS,
      'UTC',
      env,
      { fetchImpl },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).event).toMatchObject({ id: ID, title: 'Lunch', start: '12:30' });
  });

  it('keeps an all-day event all-day (and its span) when the dialog sends a whole-day slot', async () => {
    const fetchImpl = googleFetch({
      [`GET /calendars/${encodeURIComponent(WORK.id)}/events/evt1`]: () =>
        jsonResponse({
          id: 'evt1',
          summary: 'Offsite',
          start: { date: '2026-10-09' },
          end: { date: '2026-10-12' },
        }),
      [`PUT /calendars/${encodeURIComponent(WORK.id)}/events/evt1`]: (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.start).toEqual({ date: '2026-10-10' });
        expect(body.end).toEqual({ date: '2026-10-13' });
        return jsonResponse({ ...body, id: 'evt1' });
      },
    });
    const response = await updateGoogleEvent(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      ID,
      { ...FIELDS, title: 'Offsite', start: '00:00', duration: 1439 },
      'UTC',
      env,
      { fetchImpl },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).event).toMatchObject({ allDay: true, date: '2026-10-10' });
  });

  it('saves the fields first, then moves the event when the target calendar changed', async () => {
    const calls = [];
    const fetchImpl = googleFetch({
      [`GET /calendars/${encodeURIComponent(WORK.id)}/events/evt1`]: () => {
        calls.push('get');
        return jsonResponse(existing);
      },
      [`PUT /calendars/${encodeURIComponent(WORK.id)}/events/evt1`]: () => {
        calls.push('put');
        return jsonResponse({ ...existing, summary: 'Lunch' });
      },
      [`POST /calendars/${encodeURIComponent(WORK.id)}/events/evt1/move`]: (url) => {
        calls.push('move');
        expect(url.searchParams.get('destination')).toBe(PRIMARY.id);
        return jsonResponse({ ...existing, summary: 'Lunch', id: 'evt1' });
      },
    });
    const response = await updateGoogleEvent(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      ID,
      { ...FIELDS, calendar: `google:${PRIMARY.id}` },
      'UTC',
      env,
      { fetchImpl },
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual(['get', 'put', 'move']);
    expect((await response.json()).event.calendar).toBe(`google:${PRIMARY.id}`);
  });

  it('rejects a move to a stored calendar, a repeat change, and a vanished event', async () => {
    const toLocal = await updateGoogleEvent(
      createMockSql(),
      USER_ID,
      ID,
      { ...FIELDS, calendar: '11111111-1111-1111-1111-111111111111' },
      'UTC',
      env,
    );
    expect(toLocal.status).toBe(400);
    const repeat = await updateGoogleEvent(
      createMockSql(),
      USER_ID,
      ID,
      { ...FIELDS, recurrenceRule: 'DAILY' },
      'UTC',
      env,
    );
    expect(repeat.status).toBe(400);
    const malformed = await updateGoogleEvent(
      createMockSql(),
      USER_ID,
      'google:nope',
      FIELDS,
      'UTC',
      env,
    );
    expect(malformed.status).toBe(404);

    const gone = await updateGoogleEvent(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      ID,
      FIELDS,
      'UTC',
      env,
      {
        fetchImpl: googleFetch({
          [`GET /calendars/${encodeURIComponent(WORK.id)}/events/evt1`]: () =>
            jsonResponse({ error: { message: 'Not Found' } }, 404),
        }),
      },
    );
    expect(gone.status).toBe(404);
  });
});

describe('deleteGoogleEvent', () => {
  const ID = `google:${WORK.id}:evt1`;

  it('deletes through Google and treats an already-deleted event as done', async () => {
    const deleted = await deleteGoogleEvent(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      ID,
      env,
      {
        fetchImpl: googleFetch({
          [`DELETE /calendars/${encodeURIComponent(WORK.id)}/events/evt1`]: () =>
            new Response(null, { status: 204 }),
        }),
      },
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });

    const gone = await deleteGoogleEvent(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      ID,
      env,
      {
        fetchImpl: googleFetch({
          [`DELETE /calendars/${encodeURIComponent(WORK.id)}/events/evt1`]: () =>
            jsonResponse({ error: { message: 'Resource has been deleted' } }, 410),
        }),
      },
    );
    expect(await gone.json()).toEqual({ ok: true });
  });

  it('refuses read-only calendars and malformed ids', async () => {
    const readOnly = await deleteGoogleEvent(
      createMockSql([[await connectionRow({ selectedCalendars: [SHARED] })]]),
      USER_ID,
      `google:${SHARED.id}:evt1`,
      env,
    );
    expect(readOnly.status).toBe(403);
    expect((await deleteGoogleEvent(createMockSql(), USER_ID, 'google:x', env)).status).toBe(404);
  });
});

describe('getGoogleStatus', () => {
  it('describes an unconfigured deployment and an unconnected account', async () => {
    expect(await (await getGoogleStatus(createMockSql(), USER_ID, {})).json()).toEqual({
      configured: false,
      connected: false,
    });
    expect(await (await getGoogleStatus(createMockSql([[]]), USER_ID, env)).json()).toEqual({
      configured: true,
      connected: false,
    });
  });

  it('lists the live calendars with the saved selection marked, primary first', async () => {
    const fetchImpl = googleFetch({
      'GET /users/me/calendarList': () =>
        jsonResponse({
          items: [
            { id: WORK.id, summary: 'Work', backgroundColor: '#4285F4', accessRole: 'owner' },
            {
              id: SHARED.id,
              summary: 'Team',
              summaryOverride: 'The Team',
              backgroundColor: '#f6bf26',
              accessRole: 'reader',
            },
            {
              id: PRIMARY.id,
              summary: 'person@example.com',
              backgroundColor: 'bad',
              accessRole: 'owner',
              primary: true,
            },
            { id: 'deleted@example.com', summary: 'Gone', deleted: true, accessRole: 'owner' },
          ],
        }),
    });
    const response = await getGoogleStatus(
      createMockSql([[await connectionRow({ selectedCalendars: [WORK] })]]),
      USER_ID,
      env,
      { fetchImpl },
    );
    const body = await response.json();
    expect(body).toMatchObject({
      configured: true,
      connected: true,
      email: 'person@example.com',
      needsReauth: false,
    });
    expect(body.calendars).toEqual([
      {
        id: PRIMARY.id,
        name: 'person@example.com',
        color: '#4285f4',
        primary: true,
        readOnly: false,
        selected: false,
      },
      {
        id: WORK.id,
        name: 'Work',
        color: '#4285f4',
        primary: false,
        readOnly: false,
        selected: true,
      },
      {
        id: SHARED.id,
        name: 'The Team',
        color: '#f6bf26',
        primary: false,
        readOnly: true,
        selected: false,
      },
    ]);
  });

  it('falls back to the saved selection when Google cannot be reached or the grant lapsed', async () => {
    const outage = await getGoogleStatus(createMockSql([[await connectionRow()]]), USER_ID, env, {
      fetchImpl: googleFetch({
        'GET /users/me/calendarList': () =>
          jsonResponse({ error: { message: 'Backend Error' } }, 503),
      }),
    });
    const outageBody = await outage.json();
    expect(outageBody.calendarsError).toContain('could not be reached');
    expect(outageBody.calendars.map((calendar) => calendar.selected)).toEqual([true, true]);

    const lapsed = await getGoogleStatus(
      createMockSql([[await connectionRow({ needsReauth: true })]]),
      USER_ID,
      env,
    );
    const lapsedBody = await lapsed.json();
    expect(lapsedBody.needsReauth).toBe(true);
    expect(lapsedBody.calendars).toHaveLength(2);
  });
});

describe('authorizeGoogle', () => {
  const requestUrl = new URL('https://calendar-api.infinitywave.online/google-calendar');

  it('accepts a Cookie origin, keeps only its path, and answers the consent URL', async () => {
    const sql = createMockSql([[], []]);
    const response = await authorizeGoogle(
      sql,
      USER_ID,
      { action: 'authorize', returnTo: `${PRODUCTION}/settings/calendar?google=error#x` },
      requestUrl,
      env,
    );
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).url);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://calendar-api.infinitywave.online/google-calendar/callback',
    );
    expect(sql.calls[1].values[3]).toBe(`${PRODUCTION}/settings/calendar`);
  });

  it('rejects other origins, garbage, and an unconfigured deployment', async () => {
    const foreign = await authorizeGoogle(
      createMockSql(),
      USER_ID,
      { returnTo: 'https://evil.example/settings/calendar' },
      requestUrl,
      env,
    );
    expect(foreign.status).toBe(400);
    const garbage = await authorizeGoogle(
      createMockSql(),
      USER_ID,
      { returnTo: 'nope' },
      requestUrl,
      env,
    );
    expect(garbage.status).toBe(400);
    const unconfigured = await authorizeGoogle(
      createMockSql(),
      USER_ID,
      { returnTo: PRODUCTION },
      requestUrl,
      {},
    );
    expect(unconfigured.status).toBe(503);
  });
});

describe('handleGoogleCallback', () => {
  const pending = {
    userId: USER_ID,
    redirectUri: 'https://calendar-api.infinitywave.online/google-calendar/callback',
    returnTo: `${PRODUCTION}/settings/calendar`,
    expired: false,
  };

  it('exchanges the code for the state owner and sends the browser back to Settings', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
    );
    const sql = createMockSql([[pending], []]);
    const response = await handleGoogleCallback(
      sql,
      new URL(
        'https://calendar-api.infinitywave.online/google-calendar/callback?code=abc&state=s1',
      ),
      env,
      { fetchImpl },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      `${PRODUCTION}/settings/calendar?google=connected`,
    );
    expect(sql.calls[0].values[0]).toBe('s1');
    expect(sql.calls[1].values[0]).toBe(USER_ID);
  });

  it('reports a refusal or a failed exchange back to Settings, and a dead state as plain text', async () => {
    const denied = await handleGoogleCallback(
      createMockSql([[pending]]),
      new URL(
        'https://calendar-api.infinitywave.online/google-calendar/callback?error=access_denied&state=s1',
      ),
      env,
    );
    expect(denied.headers.get('Location')).toBe(
      `${PRODUCTION}/settings/calendar?google=error&reason=denied`,
    );

    const failed = await handleGoogleCallback(
      createMockSql([[pending]]),
      new URL(
        'https://calendar-api.infinitywave.online/google-calendar/callback?code=bad&state=s1',
      ),
      env,
      { fetchImpl: vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400)) },
    );
    expect(failed.headers.get('Location')).toBe(
      `${PRODUCTION}/settings/calendar?google=error&reason=failed`,
    );

    const dead = await handleGoogleCallback(
      createMockSql([[]]),
      new URL(
        'https://calendar-api.infinitywave.online/google-calendar/callback?code=abc&state=old',
      ),
      env,
    );
    expect(dead.status).toBe(400);
    expect(await dead.text()).toContain('expired');

    const unconfigured = await handleGoogleCallback(
      createMockSql(),
      new URL(
        'https://calendar-api.infinitywave.online/google-calendar/callback?code=abc&state=s1',
      ),
      {},
    );
    expect(unconfigured.status).toBe(400);
  });
});

describe('updateGoogleSelection', () => {
  const list = () =>
    googleFetch({
      'GET /users/me/calendarList': () =>
        jsonResponse({
          items: [
            {
              id: PRIMARY.id,
              summary: 'Personal',
              backgroundColor: '#9fe1e7',
              accessRole: 'owner',
              primary: true,
            },
            { id: WORK.id, summary: 'Work', backgroundColor: '#4285f4', accessRole: 'owner' },
            { id: SHARED.id, summary: 'Team', backgroundColor: '#f6bf26', accessRole: 'reader' },
          ],
        }),
    });

  it('snapshots the chosen calendars from the live list and echoes the full list', async () => {
    const sql = createMockSql([[await connectionRow({ selectedCalendars: [] })], []]);
    const response = await updateGoogleSelection(
      sql,
      USER_ID,
      { calendarIds: [SHARED.id, PRIMARY.id] },
      env,
      { fetchImpl: list() },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.calendars.map((calendar) => [calendar.id, calendar.selected])).toEqual([
      [PRIMARY.id, true],
      [WORK.id, false],
      [SHARED.id, true],
    ]);
    expect(sql.calls[1].text).toContain('SET selected_calendars =');
    expect(
      sql.calls[1].values[0].map((/** @type {{id: string}} */ calendar) => calendar.id),
    ).toEqual([SHARED.id, PRIMARY.id]);
  });

  it('validates the ids and refuses ones Google does not list', async () => {
    expect((await updateGoogleSelection(createMockSql(), USER_ID, {}, env)).status).toBe(400);
    expect(
      (await updateGoogleSelection(createMockSql(), USER_ID, { calendarIds: ['a', 'a'] }, env))
        .status,
    ).toBe(400);
    expect(
      (await updateGoogleSelection(createMockSql(), USER_ID, { calendarIds: [''] }, env)).status,
    ).toBe(400);
    expect(
      (await updateGoogleSelection(createMockSql([[]]), USER_ID, { calendarIds: [WORK.id] }, env))
        .status,
    ).toBe(404);
    const unknown = await updateGoogleSelection(
      createMockSql([[await connectionRow()]]),
      USER_ID,
      { calendarIds: ['stranger@example.com'] },
      env,
      { fetchImpl: list() },
    );
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain('not on this Google account');
  });
});

describe('disconnectGoogle', () => {
  it('removes the connection and answers ok', async () => {
    const sql = createMockSql([[await connectionRow()], []]);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const response = await disconnectGoogle(sql, USER_ID, env, { fetchImpl });
    expect(await response.json()).toEqual({ ok: true });
    expect(sql.calls[1].text).toContain('DELETE FROM google_calendar_connections');
    expect((await disconnectGoogle(createMockSql(), USER_ID, {})).status).toBe(503);
  });
});

describe('GOOGLE_API_URL', () => {
  it('points at the v3 REST API', () => {
    expect(GOOGLE_API_URL).toBe('https://www.googleapis.com/calendar/v3');
  });
});
