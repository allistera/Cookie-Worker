// Google Calendar as a live source behind the Calendar app's own endpoints.
//
// Nothing from Google is mirrored into calendar_events. Every GET
// /calendar-events window asks Google for the selected calendars' events in
// that range and merges them with the stored rows; create, update and delete
// for a `google:` id go straight to the Google Calendar API. That keeps a
// single consistent view (no sync lag, no conflict handling) at the cost of a
// Google round trip per window, which the client already pads to ±105 days.
//
// Ids on the wire are `google:<calendarId>` for calendars and
// `google:<calendarId>:<eventId>` for events, so existing clients that treat
// ids as opaque strings — the Calendar view, the Mail next-event chip, the
// daily-note sidebar — need no changes to show them.

import { isAllowedOrigin } from '../../../shared/cors.js';
import {
  CALLBACK_PATH,
  GoogleReauthRequired,
  beginAuthorization,
  completeAuthorization,
  consumeAuthorizationState,
  disconnect,
  getAccessToken,
  isGoogleConfigured,
  loadConnection,
  loadConnectionIfAvailable,
  saveSelectedCalendars,
} from './googleAuth.js';

export const GOOGLE_API_URL = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_ID_PREFIX = 'google:';
const DEFAULT_CALENDAR_COLOR = '#4285f4';
const API_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 250;
// Per calendar per window. A 210-day window with more than this many events
// on one calendar is cut off rather than paged indefinitely.
const MAX_PAGES = 4;
const MAX_SELECTED_CALENDARS = 50;
const MAX_CALENDAR_ID = 256;
const WRITABLE_ROLES = new Set(['owner', 'writer']);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * @typedef {import('./googleAuth.js').GoogleEnv & {
 *   ALLOWED_ORIGIN?: string,
 *   SENTRY_ENVIRONMENT?: string,
 * }} GoogleCalendarEnv
 */

/** @typedef {import('./googleAuth.js').SelectedGoogleCalendar} SelectedGoogleCalendar */
/** @typedef {import('./googleAuth.js').GoogleConnection} GoogleConnection */

/** @typedef {{fetchImpl?: typeof fetch, now?: () => number}} Overrides */

const REAUTH_MESSAGE = 'Google Calendar needs to be reconnected in Settings.';
const NO_GOOGLE_EVENTS = Object.freeze({ events: [], error: null, truncated: false });

export class GoogleApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Ids

/** @param {unknown} value */
export function isGoogleId(value) {
  return typeof value === 'string' && value.startsWith(GOOGLE_ID_PREFIX);
}

/** @param {string} calendarId */
export function googleCalendarKey(calendarId) {
  return `${GOOGLE_ID_PREFIX}${calendarId}`;
}

/**
 * @param {string} calendarId
 * @param {string} eventId
 */
function googleEventKey(calendarId, eventId) {
  return `${GOOGLE_ID_PREFIX}${calendarId}:${eventId}`;
}

/**
 * Splits `google:<calendarId>:<eventId>`. Google event ids never contain a
 * colon, so the last one separates the two; calendar ids never do either, but
 * splitting from the end keeps that assumption on the side that is documented.
 *
 * @param {unknown} value
 * @returns {{calendarId: string, eventId: string} | null}
 */
export function parseGoogleEventId(value) {
  if (!isGoogleId(value)) return null;
  const rest = /** @type {string} */ (value).slice(GOOGLE_ID_PREFIX.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0 || separator === rest.length - 1) return null;
  const calendarId = rest.slice(0, separator);
  const eventId = rest.slice(separator + 1);
  if (calendarId.length > MAX_CALENDAR_ID || eventId.length > 1024) return null;
  return { calendarId, eventId };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseGoogleCalendarId(value) {
  if (!isGoogleId(value)) return null;
  const calendarId = /** @type {string} */ (value).slice(GOOGLE_ID_PREFIX.length);
  return calendarId && calendarId.length <= MAX_CALENDAR_ID ? calendarId : null;
}

// ---------------------------------------------------------------------------
// Wall-clock time in the caller's zone

/** @param {unknown} value */
export function validTimeZone(value) {
  const timeZone = String(value ?? '')
    .trim()
    .slice(0, 100);
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone }).format();
    return timeZone;
  } catch {
    return null;
  }
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/** @param {string} timeZone */
function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * @param {Date | number} instant
 * @param {string} timeZone
 */
export function wallClock(instant, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const value = (/** @type {string} */ type) => parts.find((part) => part.type === type)?.value;
  // Intl can print "24" for midnight in some runtimes despite h23.
  const hour = value('hour') === '24' ? '00' : value('hour');
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${hour}:${value('minute')}`,
    seconds: Number(value('second') ?? 0),
  };
}

/**
 * The zone's UTC offset (ms) at an instant: the wall clock read as UTC minus
 * the instant itself.
 *
 * @param {number} instant
 * @param {string} timeZone
 */
function offsetAt(instant, timeZone) {
  const { date, time, seconds } = wallClock(instant, timeZone);
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, seconds) - instant;
}

/**
 * The instant at which the zone's clock reads `date` `time`. Resolves the
 * zone's offset twice so a wall-clock time just after a DST change still lands
 * on the right side of it.
 *
 * @param {string} date YYYY-MM-DD
 * @param {string} time HH:MM
 * @param {string} timeZone
 */
export function instantOf(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = asUtc - offsetAt(asUtc, timeZone);
  const offset = offsetAt(instant, timeZone);
  if (asUtc - offset !== instant) instant = asUtc - offset;
  return new Date(instant);
}

/**
 * @param {string} date YYYY-MM-DD
 * @param {number} days
 */
export function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * @param {string} date YYYY-MM-DD
 * @param {string} time HH:MM
 * @param {number} minutes
 */
function addMinutes(date, time, minutes) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes));
  return `${shifted.toISOString().slice(0, 10)}T${shifted.toISOString().slice(11, 16)}:00`;
}

// ---------------------------------------------------------------------------
// Google API client

/**
 * @typedef {{
 *   sql: import('postgres').Sql,
 *   connection: GoogleConnection,
 *   env: GoogleCalendarEnv,
 *   fetchImpl: typeof fetch,
 *   now: () => number,
 * }} Client
 */

/**
 * @param {import('postgres').Sql} sql
 * @param {GoogleConnection} connection
 * @param {GoogleCalendarEnv} env
 * @param {Overrides} [overrides]
 * @returns {Client}
 */
function createClient(sql, connection, env, overrides = {}) {
  return {
    sql,
    connection,
    env,
    fetchImpl: overrides.fetchImpl ?? fetch,
    now: overrides.now ?? Date.now,
  };
}

/** @param {Response} response */
async function googleErrorMessage(response) {
  const body = await response.json().catch(() => null);
  const message = body?.error?.message ?? body?.error_description ?? body?.error;
  return typeof message === 'string' && message ? message : `HTTP ${response.status}`;
}

/**
 * One authenticated call. A 401 refreshes the access token once and retries;
 * any other failure becomes a GoogleApiError with Google's own message.
 *
 * @param {Client} client
 * @param {string} path Relative to GOOGLE_API_URL, with its query string.
 * @param {{method?: string, body?: unknown}} [init]
 * @returns {Promise<any>} The parsed JSON body, or null for 204.
 */
async function googleRequest(client, path, init = {}) {
  const { sql, connection, env, fetchImpl, now } = client;
  const send = async (/** @type {string} */ token) =>
    fetchImpl(`${GOOGLE_API_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

  let response = await send(await getAccessToken(sql, connection, env, { fetchImpl, now }));
  if (response.status === 401) {
    response = await send(
      await getAccessToken(sql, connection, env, { force: true, fetchImpl, now }),
    );
  }
  if (!response.ok) throw new GoogleApiError(response.status, await googleErrorMessage(response));
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/** @param {string} calendarId */
const calendarPath = (calendarId) => `/calendars/${encodeURIComponent(calendarId)}`;

/**
 * @param {string} calendarId
 * @param {string} eventId
 */
const eventPath = (calendarId, eventId) =>
  `${calendarPath(calendarId)}/events/${encodeURIComponent(eventId)}`;

/**
 * Every calendar on the account's list, including ones it can only read.
 *
 * @param {Client} client
 * @returns {Promise<SelectedGoogleCalendar[]>}
 */
export async function fetchCalendarList(client) {
  /** @type {SelectedGoogleCalendar[]} */
  const calendars = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ maxResults: String(PAGE_SIZE) });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await googleRequest(client, `/users/me/calendarList?${params}`);
    for (const item of body?.items ?? []) {
      if (typeof item?.id !== 'string' || item.deleted) continue;
      calendars.push({
        id: item.id,
        name: String(item.summaryOverride || item.summary || item.id).slice(0, 100),
        color: /^#[0-9a-f]{6}$/i.test(String(item.backgroundColor ?? ''))
          ? String(item.backgroundColor).toLowerCase()
          : DEFAULT_CALENDAR_COLOR,
        primary: item.primary === true,
        readOnly: !WRITABLE_ROLES.has(String(item.accessRole ?? '')),
      });
    }
    pageToken = typeof body?.nextPageToken === 'string' ? body.nextPageToken : null;
    if (!pageToken) break;
  }
  // Primary first, then as Google orders them.
  return calendars.sort((a, b) => Number(b.primary) - Number(a.primary));
}

// ---------------------------------------------------------------------------
// Event mapping

/**
 * The Calendar app's row shape for a Google event, in the caller's zone. An
 * all-day event spanning several days becomes one row per day inside the
 * requested range (as ICS sync does), every row carrying the same seriesId so
 * the event dialog edits the event rather than a day of it.
 *
 * @param {any} item A Google Calendar API event resource.
 * @param {SelectedGoogleCalendar} calendar
 * @param {string} timeZone
 * @param {{from: string, to: string} | null} range Inclusive YYYY-MM-DD bounds for all-day rows.
 */
export function mapGoogleEvent(item, calendar, timeZone, range) {
  if (!item || item.status === 'cancelled' || typeof item.id !== 'string') return [];
  const id = googleEventKey(calendar.id, item.id);
  const base = {
    id,
    title: String(item.summary ?? '').trim() || '(No title)',
    description: typeof item.description === 'string' ? item.description : null,
    location: typeof item.location === 'string' ? item.location : null,
    calendar: googleCalendarKey(calendar.id),
    tone: null,
    recurrenceRule: null,
    autoScheduled: false,
    source: 'google',
    googleCalendarId: calendar.id,
    googleEventId: item.id,
    recurring: typeof item.recurringEventId === 'string',
    readOnly: calendar.readOnly,
    htmlLink: typeof item.htmlLink === 'string' ? item.htmlLink : null,
  };

  if (typeof item.start?.date === 'string') {
    const startDate = item.start.date;
    const endDate =
      typeof item.end?.date === 'string' && item.end.date > startDate
        ? item.end.date
        : addDays(startDate, 1);
    const firstDay = range && range.from > startDate ? range.from : startDate;
    const afterLast = range && addDays(range.to, 1) < endDate ? addDays(range.to, 1) : endDate;
    const rows = [];
    for (let day = firstDay; day < afterLast; day = addDays(day, 1)) {
      rows.push({
        ...base,
        id: day === startDate ? id : `${id}@${day}`,
        seriesId: id,
        seriesDate: startDate,
        date: day,
        start: '00:00',
        duration: 1440,
        allDay: true,
      });
    }
    return rows;
  }

  const startMs = Date.parse(item.start?.dateTime ?? '');
  const endMs = Date.parse(item.end?.dateTime ?? '');
  if (!Number.isFinite(startMs)) return [];
  const start = wallClock(startMs, timeZone);
  const duration = Number.isFinite(endMs)
    ? Math.max(Math.round((endMs - startMs) / 60_000), 1)
    : 30;
  return [{ ...base, seriesId: id, date: start.date, start: start.time, duration, allDay: false }];
}

/**
 * @param {Client} client
 * @param {SelectedGoogleCalendar} calendar
 * @param {{from: string, to: string}} range
 * @param {string} timeZone
 */
async function fetchCalendarEvents(client, calendar, range, timeZone) {
  const timeMin = instantOf(range.from, '00:00', timeZone).toISOString();
  const timeMax = instantOf(addDays(range.to, 1), '00:00', timeZone).toISOString();
  const events = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      timeZone,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(PAGE_SIZE),
    });
    if (pageToken) params.set('pageToken', pageToken);
    const body = await googleRequest(client, `${calendarPath(calendar.id)}/events?${params}`);
    for (const item of body?.items ?? []) {
      events.push(...mapGoogleEvent(item, calendar, timeZone, range));
    }
    pageToken = typeof body?.nextPageToken === 'string' ? body.nextPageToken : null;
    if (!pageToken) break;
  }
  // A page token left over after the last allowed page means the window was
  // cut short, which the response reports as `truncated` like stored rows.
  return { events, truncated: pageToken !== null };
}

/**
 * Google events for every selected calendar in the range — or for one of
 * them, when `calendar` names a `google:` calendar id. Never throws: a Google
 * outage must not take the stored events down with it, so failures come back
 * as `error` for the client to mention. Calendars are fetched independently,
 * so one that has gone (unshared, deleted) does not hide the others' events.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{from: string, to: string}} range
 * @param {string} timeZone
 * @param {GoogleCalendarEnv} env
 * @param {Overrides & {calendar?: string | null}} [overrides]
 * @returns {Promise<{events: any[], error: string | null, truncated: boolean}>}
 */
export async function listGoogleEvents(sql, userId, range, timeZone, env, overrides = {}) {
  if (!isGoogleConfigured(env)) return NO_GOOGLE_EVENTS;
  const only = overrides.calendar ? parseGoogleCalendarId(overrides.calendar) : null;
  if (overrides.calendar && !only) return NO_GOOGLE_EVENTS;
  let connection;
  try {
    connection = await loadConnectionIfAvailable(sql, userId);
  } catch (error) {
    console.error(
      'Google Calendar connection lookup failed:',
      /** @type {Error} */ (error).message,
    );
    return { ...NO_GOOGLE_EVENTS, error: 'Google Calendar is temporarily unavailable.' };
  }
  const calendars = only
    ? connection?.selectedCalendars.filter((calendar) => calendar.id === only)
    : connection?.selectedCalendars;
  if (!connection || !calendars?.length) return NO_GOOGLE_EVENTS;
  if (connection.needsReauth) return { ...NO_GOOGLE_EVENTS, error: REAUTH_MESSAGE };

  const client = createClient(sql, connection, env, overrides);
  const results = await Promise.allSettled(
    calendars.map((calendar) => fetchCalendarEvents(client, calendar, range, timeZone)),
  );
  const events = [];
  let truncated = false;
  /** @type {string | null} */
  let error = null;
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      events.push(...result.value.events);
      truncated ||= result.value.truncated;
      continue;
    }
    if (result.reason instanceof GoogleReauthRequired) {
      error = REAUTH_MESSAGE;
      continue;
    }
    console.error(
      'Google Calendar events request failed:',
      calendars[index].id,
      /** @type {Error} */ (result.reason)?.message,
    );
    error ??=
      results.length > 1
        ? `Events from the Google calendar "${calendars[index].name}" could not be loaded.`
        : 'Google Calendar events could not be loaded.';
  }
  return { events, error, truncated };
}

/**
 * The selected Google calendars in the /calendars list shape, so the sidebar
 * and event dialog treat them like any other calendar.
 *
 * @param {GoogleConnection | null} connection
 */
export function googleCalendarEntries(connection) {
  if (!connection) return [];
  return connection.selectedCalendars.map((calendar) => ({
    id: googleCalendarKey(calendar.id),
    name: calendar.name,
    color: calendar.color,
    source: 'google',
    googleCalendarId: calendar.id,
    readOnly: calendar.readOnly,
  }));
}

// ---------------------------------------------------------------------------
// Event writes

/** @param {unknown} error */
export function googleErrorResponse(error) {
  if (error instanceof GoogleReauthRequired) {
    return Response.json(
      {
        error: 'Google Calendar needs to be reconnected in Settings.',
        code: 'google_reauth_required',
      },
      { status: 409 },
    );
  }
  if (error instanceof GoogleApiError) {
    if (error.status === 404 || error.status === 410) {
      return Response.json({ error: 'Google Calendar event not found' }, { status: 404 });
    }
    if (error.status === 403) {
      return Response.json(
        { error: `Google Calendar refused the change: ${error.message}` },
        { status: 403 },
      );
    }
    console.error('Google Calendar API error:', error.status, error.message);
    return Response.json({ error: 'Google Calendar request failed' }, { status: 502 });
  }
  throw error;
}

/**
 * The connection plus the selected calendar a write targets, or the refusal
 * to send. Only selected calendars are writable through Cookie: that is the
 * set the person chose to show, and the only one the sidebar offers.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} calendarId
 * @param {GoogleCalendarEnv} env
 * @returns {Promise<{connection: GoogleConnection, calendar: SelectedGoogleCalendar} | Response>}
 */
async function writableTarget(sql, userId, calendarId, env) {
  if (!isGoogleConfigured(env)) {
    return Response.json({ error: 'Google Calendar is not configured' }, { status: 503 });
  }
  const connection = await loadConnectionIfAvailable(sql, userId);
  const calendar = connection?.selectedCalendars.find((item) => item.id === calendarId);
  if (!connection || !calendar) {
    return Response.json({ error: 'Calendar not found' }, { status: 404 });
  }
  if (calendar.readOnly) {
    return Response.json({ error: 'This Google calendar is read-only.' }, { status: 403 });
  }
  return { connection, calendar };
}

/**
 * @typedef {{
 *   title: string,
 *   description: string | null,
 *   location: string | null,
 *   date: string,
 *   start: string,
 *   duration: number,
 *   calendar: string,
 *   recurrenceRule: string | null,
 * }} EventFields
 */

/**
 * Google's start/end for Cookie's date + start + duration. A whole-day span
 * starting at midnight keeps (or becomes) an all-day event: the event dialog
 * has no all-day switch, so that is how one comes back from it.
 *
 * @param {EventFields} fields
 * @param {string} timeZone
 * @param {number} [allDaySpanDays] Preserved span of an existing all-day event.
 */
function googleEventTimes(fields, timeZone, allDaySpanDays) {
  const wholeDay = fields.start === '00:00' && fields.duration >= 1439;
  if (wholeDay && allDaySpanDays) {
    return {
      start: { date: fields.date },
      end: { date: addDays(fields.date, allDaySpanDays) },
    };
  }
  return {
    start: { dateTime: `${fields.date}T${fields.start}:00`, timeZone },
    end: { dateTime: addMinutes(fields.date, fields.start, fields.duration), timeZone },
  };
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {EventFields} fields
 * @param {string} timeZone
 * @param {GoogleCalendarEnv} env
 * @param {Overrides} [overrides]
 */
export async function createGoogleEvent(sql, userId, fields, timeZone, env, overrides = {}) {
  if (fields.recurrenceRule) {
    return Response.json(
      { error: 'Repeating Google Calendar events can only be created in Google Calendar.' },
      { status: 400 },
    );
  }
  const calendarId = parseGoogleCalendarId(fields.calendar);
  if (!calendarId) return Response.json({ error: 'Calendar not found' }, { status: 404 });
  const target = await writableTarget(sql, userId, calendarId, env);
  if (target instanceof Response) return target;

  const client = createClient(sql, target.connection, env, overrides);
  try {
    const created = await googleRequest(client, `${calendarPath(calendarId)}/events`, {
      method: 'POST',
      body: {
        summary: fields.title,
        description: fields.description ?? undefined,
        location: fields.location ?? undefined,
        ...googleEventTimes(fields, timeZone),
      },
    });
    const [event] = mapGoogleEvent(created, target.calendar, timeZone, null);
    return Response.json({ event }, { status: 201 });
  } catch (error) {
    return googleErrorResponse(error);
  }
}

/**
 * Replaces the event's own fields and times, then moves it when the target
 * calendar changed. Fetching the current resource and putting it back (rather
 * than patching) is what lets an all-day event switch to timed and back
 * without Google seeing both a `date` and a `dateTime`. The update goes first
 * so a failed move leaves a saved event where the client still knows it is.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id `google:<calendarId>:<eventId>`
 * @param {EventFields} fields
 * @param {string} timeZone
 * @param {GoogleCalendarEnv} env
 * @param {Overrides} [overrides]
 */
export async function updateGoogleEvent(sql, userId, id, fields, timeZone, env, overrides = {}) {
  const source = parseGoogleEventId(id);
  const destinationId = parseGoogleCalendarId(fields.calendar);
  if (!source) return Response.json({ error: 'Event not found' }, { status: 404 });
  if (!destinationId) {
    return Response.json(
      { error: 'A Google Calendar event can only move to another Google calendar.' },
      { status: 400 },
    );
  }
  if (fields.recurrenceRule) {
    return Response.json(
      { error: 'Change how a Google Calendar event repeats in Google Calendar.' },
      { status: 400 },
    );
  }
  const target = await writableTarget(sql, userId, destinationId, env);
  if (target instanceof Response) return target;
  if (
    source.calendarId !== destinationId &&
    !target.connection.selectedCalendars.some(
      (calendar) => calendar.id === source.calendarId && !calendar.readOnly,
    )
  ) {
    return Response.json({ error: 'This Google calendar is read-only.' }, { status: 403 });
  }

  const client = createClient(sql, target.connection, env, overrides);
  try {
    const existing = await googleRequest(client, eventPath(source.calendarId, source.eventId));
    const allDaySpanDays =
      typeof existing?.start?.date === 'string'
        ? Math.max(
            Math.round(
              (Date.parse(existing.end?.date ?? existing.start.date) -
                Date.parse(existing.start.date)) /
                MS_PER_DAY,
            ),
            1,
          )
        : undefined;
    let updated = await googleRequest(client, eventPath(source.calendarId, source.eventId), {
      method: 'PUT',
      body: {
        ...existing,
        summary: fields.title,
        description: fields.description ?? undefined,
        location: fields.location ?? undefined,
        ...googleEventTimes(fields, timeZone, allDaySpanDays),
      },
    });
    if (source.calendarId !== destinationId) {
      updated = await googleRequest(
        client,
        `${eventPath(source.calendarId, source.eventId)}/move?destination=${encodeURIComponent(destinationId)}`,
        { method: 'POST' },
      );
    }
    const [event] = mapGoogleEvent(updated, target.calendar, timeZone, null);
    return Response.json({ event });
  } catch (error) {
    return googleErrorResponse(error);
  }
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id `google:<calendarId>:<eventId>`
 * @param {GoogleCalendarEnv} env
 * @param {Overrides} [overrides]
 */
export async function deleteGoogleEvent(sql, userId, id, env, overrides = {}) {
  const parsed = parseGoogleEventId(id);
  if (!parsed) return Response.json({ error: 'Event not found' }, { status: 404 });
  const target = await writableTarget(sql, userId, parsed.calendarId, env);
  if (target instanceof Response) return target;

  const client = createClient(sql, target.connection, env, overrides);
  try {
    await googleRequest(client, eventPath(parsed.calendarId, parsed.eventId), {
      method: 'DELETE',
    });
    return Response.json({ ok: true });
  } catch (error) {
    // Already gone counts as deleted.
    if (error instanceof GoogleApiError && error.status === 410) return Response.json({ ok: true });
    return googleErrorResponse(error);
  }
}

// ---------------------------------------------------------------------------
// /google-calendar: connection management for Settings

/**
 * @param {GoogleConnection} connection
 * @param {SelectedGoogleCalendar[]} available
 */
function withSelection(connection, available) {
  const selected = new Set(connection.selectedCalendars.map((calendar) => calendar.id));
  return available.map((calendar) => ({ ...calendar, selected: selected.has(calendar.id) }));
}

/**
 * GET /google-calendar
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {GoogleCalendarEnv} env
 * @param {Overrides} [overrides]
 */
export async function getGoogleStatus(sql, userId, env, overrides = {}) {
  if (!isGoogleConfigured(env)) {
    return Response.json({ configured: false, connected: false });
  }
  const connection = await loadConnectionIfAvailable(sql, userId);
  if (!connection) return Response.json({ configured: true, connected: false });

  const status = {
    configured: true,
    connected: true,
    email: connection.email,
    needsReauth: connection.needsReauth,
  };
  if (connection.needsReauth) {
    return Response.json({
      ...status,
      calendars: withSelection(connection, connection.selectedCalendars),
    });
  }
  try {
    const available = await fetchCalendarList(createClient(sql, connection, env, overrides));
    return Response.json({ ...status, calendars: withSelection(connection, available) });
  } catch (error) {
    if (error instanceof GoogleReauthRequired) {
      return Response.json({
        ...status,
        needsReauth: true,
        calendars: withSelection(connection, connection.selectedCalendars),
      });
    }
    console.error('Google calendar list failed:', /** @type {Error} */ (error).message);
    // The stored selection still describes what Cookie shows; the person can
    // retry the live list later.
    return Response.json({
      ...status,
      calendars: withSelection(connection, connection.selectedCalendars),
      calendarsError: 'Google Calendar could not be reached. Showing your saved selection.',
    });
  }
}

/**
 * POST /google-calendar with action=authorize. `returnTo` is the Settings URL
 * the callback should send the browser back to; only an origin the Worker
 * already serves (its CORS allowlist) is accepted, and only its path is kept.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {URL} requestUrl
 * @param {GoogleCalendarEnv} env
 */
export async function authorizeGoogle(sql, userId, body, requestUrl, env) {
  if (!isGoogleConfigured(env)) {
    return Response.json({ error: 'Google Calendar is not configured' }, { status: 503 });
  }
  let returnTo;
  try {
    const parsed = new URL(String(body.returnTo ?? ''));
    if (!isAllowedOrigin(parsed.origin, env.ALLOWED_ORIGIN, env.SENTRY_ENVIRONMENT)) {
      throw new Error('origin not allowed');
    }
    returnTo = `${parsed.origin}${parsed.pathname}`;
  } catch {
    return Response.json({ error: 'returnTo must be a Cookie URL' }, { status: 400 });
  }
  const redirectUri = `${requestUrl.origin}${CALLBACK_PATH}`;
  const url = await beginAuthorization(sql, userId, { redirectUri, returnTo }, env);
  return Response.json({ url });
}

/**
 * GET /google-calendar/callback — Google sends the browser here. Unauthenticated
 * by nature (a top-level navigation), so the state row is the only link to a
 * user; without a valid one there is nowhere to redirect, and a plain page says
 * so.
 *
 * @param {import('postgres').Sql} sql
 * @param {URL} url
 * @param {GoogleCalendarEnv} env
 * @param {Overrides} [overrides]
 */
export async function handleGoogleCallback(sql, url, env, overrides = {}) {
  const state = url.searchParams.get('state') ?? '';
  const pending = isGoogleConfigured(env) ? await consumeAuthorizationState(sql, state) : null;
  if (!pending) {
    return new Response(
      'This Google sign-in link has expired or was already used. Return to Cookie and try again.',
      { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }

  const back = new URL(pending.returnTo);
  const code = url.searchParams.get('code');
  if (url.searchParams.get('error') || !code) {
    back.searchParams.set('google', 'error');
    back.searchParams.set(
      'reason',
      url.searchParams.get('error') === 'access_denied' ? 'denied' : 'failed',
    );
    return Response.redirect(back.toString(), 302);
  }

  try {
    await completeAuthorization(
      sql,
      pending.userId,
      { code, redirectUri: pending.redirectUri },
      env,
      overrides.fetchImpl,
    );
    back.searchParams.set('google', 'connected');
  } catch (error) {
    console.error('Google Calendar connection failed:', /** @type {Error} */ (error).message);
    back.searchParams.set('google', 'error');
    back.searchParams.set('reason', 'failed');
  }
  return Response.redirect(back.toString(), 302);
}

/**
 * PATCH /google-calendar — which calendars show in Cookie. The chosen ones are
 * snapshotted (name, colour, access) so /calendars and every event window can
 * list them without another calendarList call.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {GoogleCalendarEnv} env
 * @param {Overrides} [overrides]
 */
export async function updateGoogleSelection(sql, userId, body, env, overrides = {}) {
  const ids = Array.isArray(body.calendarIds) ? body.calendarIds : null;
  if (
    !ids ||
    ids.length > MAX_SELECTED_CALENDARS ||
    ids.some(
      (/** @type {unknown} */ id) => typeof id !== 'string' || !id || id.length > MAX_CALENDAR_ID,
    ) ||
    new Set(ids).size !== ids.length
  ) {
    return Response.json(
      { error: 'calendarIds must be a list of Google calendar ids' },
      { status: 400 },
    );
  }
  if (!isGoogleConfigured(env)) {
    return Response.json({ error: 'Google Calendar is not configured' }, { status: 503 });
  }
  const connection = await loadConnectionIfAvailable(sql, userId);
  if (!connection) {
    return Response.json({ error: 'Google Calendar is not connected' }, { status: 404 });
  }

  let available;
  try {
    available = await fetchCalendarList(createClient(sql, connection, env, overrides));
  } catch (error) {
    return googleErrorResponse(error);
  }
  const byId = new Map(available.map((calendar) => [calendar.id, calendar]));
  if (ids.some((/** @type {string} */ id) => !byId.has(id))) {
    return Response.json(
      { error: 'One of the calendars is not on this Google account' },
      { status: 400 },
    );
  }
  const selected = ids.map(
    (/** @type {string} */ id) => /** @type {SelectedGoogleCalendar} */ (byId.get(id)),
  );
  await saveSelectedCalendars(sql, userId, selected);
  connection.selectedCalendars = selected;
  return Response.json({ calendars: withSelection(connection, available) });
}

/**
 * DELETE /google-calendar
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {GoogleCalendarEnv} env
 * @param {Overrides} [overrides]
 */
export async function disconnectGoogle(sql, userId, env, overrides = {}) {
  if (!isGoogleConfigured(env)) {
    return Response.json({ error: 'Google Calendar is not configured' }, { status: 503 });
  }
  await disconnect(sql, userId, env, overrides.fetchImpl);
  return Response.json({ ok: true });
}

export { loadConnection };
