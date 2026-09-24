// Ported from Cookie-Web's api/_lib/calendarSync.js. The parsing/expansion
// and transactional replace are unchanged; the egress boundary changes with
// the runtime. Cookie-Web's api/_lib/safe-https.js resolved the hostname via
// node:dns and pinned the HTTPS connection to the verified IP — Workers'
// fetch() has no pinning primitive, so requestPublicHttps below pre-resolves
// via shared/safe-https.js's DNS-over-HTTPS check (rejecting private
// addresses) and then fetches normally, the same documented trade-off
// cookie-web-messages made for one-click unsubscribe. Subscription URLs are
// supplied by the authenticated owner (not attacker-controlled headers), and
// Workers egress originates from Cloudflare's edge rather than inside any
// private network, so the residual DNS-rebinding window is accepted here.

import ical from 'node-ical';

import { hostMatchesSuffixes, resolvePublicHttpsUrl } from '../../../shared/safe-https.js';

const MAX_TITLE = 200;
const MAX_LOCATION = 200;
const MAX_DESCRIPTION = 2000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXPAND_PAST_DAYS = 365;
const EXPAND_FUTURE_DAYS = 730;
const MAX_OCCURRENCES_PER_EVENT = 366;
const MAX_EVENTS_PER_SYNC = 1000;
const TIME_RE = /^\d{2}:\d{2}$/;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
// A sync failure message can quote remote-controlled feed content (node-ical
// echoes the offending line back), and the column is unbounded text that the
// sidebar renders. Bound it before it is stored.
const MAX_SYNC_ERROR_CHARS = 500;

// Calendar subscriptions are supplied by an authenticated owner, but a
// compromised or malicious account can still use DNS rebinding to make the
// Worker request an unintended address. The DoH check in resolvePublicHttpsUrl
// rejects obviously private/internal targets, but fetch() re-resolves
// independently, so we also constrain hosts to known public calendar providers.
// Operators can extend or replace this list with CALENDAR_SUBSCRIPTION_ALLOWLIST.
export const DEFAULT_CALENDAR_ALLOWLIST = [
  'calendar.google.com',
  'www.google.com',
  'outlook.office365.com',
  'outlook.live.com',
  'calendar.yahoo.com',
  'caldav.fastmail.com',
  'calendar.fastmail.com',
  'calendar.zoho.com',
  'p01-caldav.icloud.com',
  'p02-caldav.icloud.com',
  'p03-caldav.icloud.com',
  'p04-caldav.icloud.com',
  'p05-caldav.icloud.com',
  'p06-caldav.icloud.com',
  'p07-caldav.icloud.com',
  'p08-caldav.icloud.com',
  'p09-caldav.icloud.com',
  'p10-caldav.icloud.com',
];

// The pinned public-HTTPS boundary, Workers edition: DoH-validate the target,
// fetch without following redirects (the caller reports 3xx explicitly), and
// stream the body under a byte cap so a huge feed cannot buffer unbounded.
/**
 * @param {string} url
 * @param {{timeoutMs: number, maxResponseBytes: number, headers?: Record<string, string>}} options
 * @returns {Promise<{status: number, body: Uint8Array}>}
 */
export async function requestPublicHttps(url, { timeoutMs, maxResponseBytes, headers }) {
  const target = await resolvePublicHttpsUrl(url);
  const response = await fetch(target, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const reader = response.body?.getReader();
  const chunks = [];
  let received = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('The calendar feed is too large');
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: response.status, body };
}

// Credential-bearing URLs are rejected here rather than only at the egress
// boundary (resolvePublicHttpsUrl), so subscribing to one fails as a 400 at
// create time instead of storing a calendar whose every sync errors out.
// webcal:// (the scheme calendar apps hand out for ICS feeds) is accepted and
// stored as its https:// equivalent, so every later sync goes through the
// same public-HTTPS egress path as a plain https subscription.
/**
 * @param {unknown} value
 * @param {string[]} [allowlist] Hostname suffixes allowed for subscriptions.
 *        Defaults to DEFAULT_CALENDAR_ALLOWLIST.
 */
export function validSubscriptionUrl(value, allowlist = DEFAULT_CALENDAR_ALLOWLIST) {
  const url = String(value ?? '');
  if (!url || url.length > 2000) return null;
  const normalized = url.replace(/^webcal:\/\//i, 'https://');
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  if (allowlist.length > 0 && !hostMatchesSuffixes(parsed.hostname, allowlist)) return null;
  return parsed.toString();
}

/**
 * Reads an operator-provided comma-separated hostname allowlist. An empty or
 * missing value falls back to the built-in default list.
 * @param {{ CALENDAR_SUBSCRIPTION_ALLOWLIST?: string }} env
 * @returns {string[]}
 */
export function calendarSubscriptionAllowlist(env) {
  const raw = env?.CALENDAR_SUBSCRIPTION_ALLOWLIST;
  if (!raw) return DEFAULT_CALENDAR_ALLOWLIST;
  return raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {string} url
 * @param {typeof requestPublicHttps} request
 */
export async function fetchIcs(url, request) {
  const response = await request(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    headers: { Accept: 'text/calendar, text/plain, */*' },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error('The calendar URL redirected; redirects are not followed');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The calendar URL responded with status ${response.status}`);
  }
  return new TextDecoder().decode(response.body);
}

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');
/** @param {Date} date */
const toDateKeyUTC = (date) =>
  `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
/** @param {Date} date */
const toTimeKeyUTC = (date) => `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
// node-ical builds a date-only (VALUE=DATE) VEVENT's start/end by
// interpreting the date components as local time, so recovering the
// intended calendar date must use local getters too — UTC getters would
// shift the date by a day in any timezone that isn't UTC+0.
/** @param {Date} date */
const toDateKeyLocal = (date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
/** @param {Date} date */
const toTimeKeyLocal = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

/**
 * @param {Date} date
 * @param {string | undefined} timeZone
 * @param {Map<string, Intl.DateTimeFormat>} formatters
 */
function timedOccurrenceKeys(date, timeZone, formatters) {
  if (!timeZone) {
    return { date: toDateKeyLocal(date), time: toTimeKeyLocal(date) };
  }
  if (timeZone === 'Etc/UTC' || timeZone === 'UTC') {
    return { date: toDateKeyUTC(date), time: toTimeKeyUTC(date) };
  }

  try {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      formatters.set(timeZone, formatter);
    }
    const parts = formatter.formatToParts(date);
    const value = (/** @type {string} */ type) => parts.find((part) => part.type === type)?.value;
    return {
      date: `${value('year')}-${value('month')}-${value('day')}`,
      time: `${value('hour')}:${value('minute')}`,
    };
  } catch {
    // node-ical has already resolved the instant. If a feed supplies a TZID
    // that this runtime does not know, UTC is the only deterministic fallback.
    return { date: toDateKeyUTC(date), time: toTimeKeyUTC(date) };
  }
}

/**
 * @param {Date} date
 * @param {number} days
 */
function addDaysLocal(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** @param {Date} date */
function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// A timed (non-all-day) occurrence: one row, positioned by its actual
// start time and duration.
/**
 * @param {any} rrule
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @param {number} max
 */
function rruleOccurrences(rrule, windowStart, windowEnd, max) {
  if (!rrule || !(rrule.between instanceof Function)) return [];
  /** @type {Date[]} */
  const dates = [];
  const result = rrule.between(windowStart, windowEnd, true, (/** @type {Date} */ date) => {
    dates.push(date);
    return dates.length < max;
  });
  if (dates.length > 0) return dates;
  return Array.isArray(result) ? result.slice(0, max) : [];
}

/**
 * @param {any} event
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @param {Map<string, Intl.DateTimeFormat>} formatters
 */
function timedOccurrences(event, windowStart, windowEnd, formatters) {
  const starts = event.rrule
    ? rruleOccurrences(event.rrule, windowStart, windowEnd, MAX_OCCURRENCES_PER_EVENT)
    : event.start >= windowStart && event.start <= windowEnd
      ? [event.start]
      : [];

  const durationMs = Math.max(
    new Date(event.end).getTime() - new Date(event.start).getTime(),
    60_000,
  );
  const durationMinutes = Math.round(durationMs / 60_000);
  return starts.map((/** @type {Date} */ start) => {
    const keys = timedOccurrenceKeys(new Date(start), event.start.tz, formatters);
    return {
      date: keys.date,
      time: keys.time,
      durationMinutes,
      allDay: false,
    };
  });
}

// An all-day occurrence is expanded into one row per calendar day it spans,
// each flagged all_day so the UI renders it as a compact banner instead of
// positioning it in the hourly grid (which is what previously made a single
// all-day event stretch across the entire visible timeline). RFC5545 all-day
// DTEND is exclusive — a "Aug 10-13" span covers the 10th, 11th, and 12th.
/**
 * @param {any} event
 * @param {Date} windowStart
 * @param {Date} windowEnd
 */
export function allDayOccurrences(event, windowStart, windowEnd) {
  const spanDays = Math.max(
    Math.round((event.end.getTime() - event.start.getTime()) / MS_PER_DAY),
    1,
  );
  const starts = event.rrule
    ? rruleOccurrences(event.rrule, windowStart, windowEnd, MAX_OCCURRENCES_PER_EVENT)
    : [event.start];

  const rows = [];
  const firstWindowDay = startOfLocalDay(windowStart);
  const afterLastWindowDay = addDaysLocal(startOfLocalDay(windowEnd), 1);
  for (const occurrenceStart of starts) {
    const firstOccurrenceDay = startOfLocalDay(new Date(occurrenceStart));
    const afterLastOccurrenceDay = addDaysLocal(firstOccurrenceDay, spanDays);
    const firstDay = firstOccurrenceDay < firstWindowDay ? firstWindowDay : firstOccurrenceDay;
    const afterLastDay =
      afterLastOccurrenceDay > afterLastWindowDay ? afterLastWindowDay : afterLastOccurrenceDay;

    for (let day = firstDay; day < afterLastDay; day = addDaysLocal(day, 1)) {
      rows.push({ date: toDateKeyLocal(day), time: '00:00', durationMinutes: 1440, allDay: true });
      if (rows.length >= MAX_OCCURRENCES_PER_EVENT) return rows;
    }
  }
  return rows;
}

// Occurrences are materialized as plain rows rather than stored as our own
// recurrence_rule: an arbitrary ICS RRULE (BYDAY, BYSETPOS, exceptions, ...)
// doesn't map onto the app's own small daily/weekly/monthly/yearly model, and
// these events are sync-managed and never hand-edited, so there's no need to
// keep them re-expandable.
/**
 * @param {any} event
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @param {Map<string, Intl.DateTimeFormat>} formatters
 */
function eventOccurrences(event, windowStart, windowEnd, formatters) {
  return event.datetype === 'date'
    ? allDayOccurrences(event, windowStart, windowEnd)
    : timedOccurrences(event, windowStart, windowEnd, formatters);
}

/**
 * @param {string} icsText
 * @param {Date} windowStart
 * @param {Date} windowEnd
 */
function parseEvents(icsText, windowStart, windowEnd) {
  const parsed = ical.parseICS(icsText);
  const formatters = new Map();
  const rows = [];
  for (const value of /** @type {any[]} */ (Object.values(parsed))) {
    if (value.type !== 'VEVENT' || !value.start) continue;
    const title =
      String(value.summary || 'Untitled event')
        .trim()
        .slice(0, MAX_TITLE) || 'Untitled event';
    const description = value.description
      ? String(value.description).slice(0, MAX_DESCRIPTION)
      : null;
    const location = value.location ? String(value.location).slice(0, MAX_LOCATION) : null;

    for (const occurrence of eventOccurrences(value, windowStart, windowEnd, formatters)) {
      if (!TIME_RE.test(occurrence.time)) continue;
      rows.push({
        title,
        description,
        location,
        date: occurrence.date,
        start: occurrence.time,
        duration: occurrence.durationMinutes,
        all_day: occurrence.allDay,
      });
      if (rows.length >= MAX_EVENTS_PER_SYNC) return rows;
    }
  }
  return rows;
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} calendarId
 * @param {unknown} error
 */
async function recordSyncError(sql, calendarId, error) {
  const detail = (error instanceof Error ? error.message : 'Sync failed').slice(
    0,
    MAX_SYNC_ERROR_CHARS,
  );
  // Log the (capped) remote-controlled detail internally, but never echo it
  // back to the client — feed parser errors can contain attacker-controlled
  // calendar content.
  console.log(JSON.stringify({ event: 'calendar_sync_error', calendarId, detail }));
  const clientMessage = 'Could not sync the calendar subscription';
  await sql`UPDATE calendars SET subscription_error = ${clientMessage} WHERE id = ${calendarId}`;
  return { ok: false, error: clientMessage };
}

// Re-syncing replaces every event in the calendar wholesale rather than
// diffing against the previous fetch — subscribed calendars are entirely
// sync-owned, so there's no local edit state to preserve across a resync,
// and a full replace is far simpler than tracking per-occurrence identity
// against an external feed that has none.
// `request` is an injectable seam over the pinned public-HTTPS boundary so
// tests can script feed responses without mocking the safe-https module.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} calendarId
 * @param {string} userId
 * @param {string} url
 * @param {typeof requestPublicHttps} [request]
 */
export async function syncCalendarSubscription(
  sql,
  calendarId,
  userId,
  url,
  request = requestPublicHttps,
) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - EXPAND_PAST_DAYS * MS_PER_DAY);
  const windowEnd = new Date(now.getTime() + EXPAND_FUTURE_DAYS * MS_PER_DAY);

  let rows;
  try {
    const icsText = await fetchIcs(url, request);
    rows = parseEvents(icsText, windowStart, windowEnd);
  } catch (error) {
    return recordSyncError(sql, calendarId, error);
  }

  try {
    await sql.begin(async (tx) => {
      // Serialize overlapping syncs for the same calendar so two in-flight
      // replaces cannot interleave delete+insert.
      await tx`SELECT id FROM calendars WHERE id = ${calendarId} AND user_id = ${userId} FOR UPDATE`;
      // user_id isn't authorization here (callers own the calendar id); it
      // lets the composite (user_id, calendar) index serve the delete —
      // calendar alone has no usable index and seq-scanned on every sync.
      await tx`DELETE FROM calendar_events WHERE user_id = ${userId} AND calendar = ${calendarId}`;
      if (rows.length > 0) {
        // Pass the array itself, not a pre-stringified JSON string: postgres.js
        // resolves the ::json cast's OID from the server and applies its own
        // JSON.stringify when binding, so stringifying here too double-encodes
        // the value into a JSON string (a scalar) instead of an array, which
        // json_to_recordset then rejects.
        await tx`
          INSERT INTO calendar_events (user_id, title, description, location, event_date, start_time, duration_minutes, calendar, tone, all_day)
          SELECT ${userId}, row.title, row.description, row.location, row.date, row.start, row.duration::int, ${calendarId}, 'default', row.all_day
          FROM json_to_recordset(${rows}::json) AS row(title text, description text, location text, date text, start text, duration int, all_day boolean)
        `;
      }
      await tx`UPDATE calendars SET subscription_synced_at = now(), subscription_error = null WHERE id = ${calendarId}`;
    });
  } catch (error) {
    return recordSyncError(sql, calendarId, error);
  }
  return { ok: true, count: rows.length };
}
