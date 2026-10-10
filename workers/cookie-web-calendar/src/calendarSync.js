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
// The caps are spent separately on each side of "now": counted from the
// start of the past window, a daily series older than a year (or a busy
// feed's history) used to exhaust them before reaching any future
// occurrence. The past gets its own allowance: a daily series' whole year
// per event, but a smaller share of the feed-wide cap.
const MAX_OCCURRENCES_PER_EVENT = 366;
const MAX_PAST_OCCURRENCES_PER_EVENT = 366;
const MAX_EVENTS_PER_SYNC = 1000;
const MAX_PAST_EVENTS_PER_SYNC = 500;
// Stored in subscription_error on an otherwise successful sync, so the
// sidebar shows that the feed was only partly imported.
const TRUNCATED_SYNC_WARNING =
  'Some events were not imported because this calendar has too many occurrences';
const TIME_RE = /^\d{2}:\d{2}$/;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
// A sync failure message can quote remote-controlled feed content (node-ical
// echoes the offending line back), and the column is unbounded text that the
// sidebar renders. Bound it before it is stored.
const MAX_SYNC_ERROR_CHARS = 500;

// Calendar feeds may live on any public HTTPS host. Operators can restrict
// providers with CALENDAR_SUBSCRIPTION_ALLOWLIST (hostname suffixes).
// The DoH check rejects private/internal addresses before fetching, but
// Workers fetch() re-resolves independently: the DNS-rebinding limitation
// documented in shared/safe-https.js still applies.
/** @type {string[]} */
export const DEFAULT_CALENDAR_ALLOWLIST = [];

// The public-HTTPS boundary, Workers edition: DoH-validate the target,
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

// Google Calendar's share dialog hands out an "add this calendar" page link
// (https://calendar.google.com/calendar/u/0?cid=<base64 calendar id>), not a
// feed. Fetching it returns the Google Calendar HTML landing page, so a
// subscription stored as-is syncs nothing. Rewrite it to the calendar's public
// ICS address — the feed that page would have added. Only calendars shared as
// public serve that address; a private one still fails at sync time.
const GOOGLE_SHARE_HOSTS = ['calendar.google.com', 'www.google.com'];
const GOOGLE_ICAL_PATH_PREFIX = '/calendar/ical/';
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;

/** @param {URL} parsed */
function isGoogleShareLink(parsed) {
  return (
    GOOGLE_SHARE_HOSTS.includes(parsed.hostname) &&
    !parsed.pathname.startsWith(GOOGLE_ICAL_PATH_PREFIX) &&
    parsed.searchParams.has('cid')
  );
}

/**
 * @param {URL} shareLink
 * @returns {URL | null} The public ICS URL, or null when cid is not a calendar id.
 */
function googleShareLinkToIcs(shareLink) {
  const cid = shareLink.searchParams.get('cid') ?? '';
  const base64 = cid.replace(/-/g, '+').replace(/_/g, '/');
  let calendarId;
  try {
    calendarId = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  } catch {
    return null;
  }
  if (!PRINTABLE_ASCII_RE.test(calendarId)) return null;
  return new URL(
    `https://calendar.google.com${GOOGLE_ICAL_PATH_PREFIX}${encodeURIComponent(calendarId)}/public/basic.ics`,
  );
}

// Credential-bearing URLs are rejected here rather than only at the egress
// boundary (resolvePublicHttpsUrl), so subscribing to one fails as a 400 at
// create time instead of storing a calendar whose every sync errors out.
// webcal:// (the scheme calendar apps hand out for ICS feeds) is accepted and
// stored as its https:// equivalent, so every later sync goes through the
// same public-HTTPS egress path as a plain https subscription.
/**
 * @param {unknown} value
 * @param {string[]} [allowlist] Hostname suffixes allowed for subscriptions;
 *        empty (the default) allows any public HTTPS host.
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
  if (isGoogleShareLink(parsed)) {
    // A share link whose cid is not a calendar id is rejected outright rather
    // than stored as a page URL that can never sync.
    const feed = googleShareLinkToIcs(parsed);
    if (!feed) return null;
    parsed = feed;
  }
  if (allowlist.length > 0 && !hostMatchesSuffixes(parsed.hostname, allowlist)) return null;
  return parsed.toString();
}

/**
 * Reads an operator-provided comma-separated hostname allowlist. An empty or
 * missing value means any public HTTPS host.
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

/** @param {any} event */
const isCancelled = (event) => String(event?.status ?? '').toUpperCase() === 'CANCELLED';

// Every occurrence's own start/end. Recurring events go through node-ical's
// expandRecurringEvent (as calendarAvailability.js does) so EXDATEs drop
// their instances and RECURRENCE-ID overrides move or retime theirs; an
// instance whose own VEVENT (the override, else the master) is
// STATUS:CANCELLED is skipped. expandRecurringEvent enumerates every RRULE
// date in its range without a cap, so a capped iteration first finds where
// the max-th start falls and the expansion stops there; asking for one more
// than max tells a cut-off series apart from one that ends exactly at it.
// expandOngoing also yields an instance that started before windowStart but
// is still running (an all-day span crossing into today).
/**
 * @param {any} event
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @param {number} max
 * @param {boolean} [expandOngoing]
 * @returns {{spans: {start: Date, end: Date}[], truncated: boolean}}
 */
function occurrenceSpans(event, windowStart, windowEnd, max, expandOngoing = false) {
  if (!event.rrule) {
    return {
      spans: isCancelled(event) ? [] : [{ start: event.start, end: event.end }],
      truncated: false,
    };
  }
  const capped = rruleOccurrences(event.rrule, windowStart, windowEnd, max + 1);
  const truncated = capped.length > max;
  const to = truncated ? new Date(capped[max - 1]) : windowEnd;
  const spans = ical
    .expandRecurringEvent(event, { from: windowStart, to, expandOngoing })
    .filter((instance) => !isCancelled(instance.event ?? event))
    .map((instance) => ({ start: instance.start, end: instance.end }));
  return { spans: spans.slice(0, max), truncated: truncated || spans.length > max };
}

// A timed (non-all-day) occurrence: one row, positioned by its actual
// start time and duration.
/**
 * @param {any} event
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @param {number} max
 * @param {Map<string, Intl.DateTimeFormat>} formatters
 */
function timedOccurrences(event, windowStart, windowEnd, max, formatters) {
  const { spans: all, truncated } = occurrenceSpans(event, windowStart, windowEnd, max);
  const spans = all.filter(({ start }) => start >= windowStart && start <= windowEnd);

  const rows = spans.map(({ start, end }) => {
    const durationMs = Math.max(new Date(end).getTime() - new Date(start).getTime(), 60_000);
    // An override carries its own TZID (copied onto its start by node-ical);
    // plain RRULE instances carry the master's.
    const timeZone = /** @type {any} */ (start).tz ?? event.start.tz;
    const keys = timedOccurrenceKeys(new Date(start), timeZone, formatters);
    return {
      date: keys.date,
      time: keys.time,
      durationMinutes: Math.round(durationMs / 60_000),
      allDay: false,
    };
  });
  return { rows, truncated };
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
 * @param {number} [max]
 */
export function allDayOccurrences(event, windowStart, windowEnd, max = MAX_OCCURRENCES_PER_EVENT) {
  const rows = [];
  const firstWindowDay = startOfLocalDay(windowStart);
  const afterLastWindowDay = addDaysLocal(startOfLocalDay(windowEnd), 1);
  const { spans, truncated } = occurrenceSpans(event, windowStart, windowEnd, max, true);
  for (const { start, end } of spans) {
    const firstOccurrenceDay = startOfLocalDay(new Date(start));
    const spanDays = Math.max(
      Math.round(
        (startOfLocalDay(new Date(end)).getTime() - firstOccurrenceDay.getTime()) / MS_PER_DAY,
      ),
      1,
    );
    const afterLastOccurrenceDay = addDaysLocal(firstOccurrenceDay, spanDays);
    const firstDay = firstOccurrenceDay < firstWindowDay ? firstWindowDay : firstOccurrenceDay;
    const afterLastDay =
      afterLastOccurrenceDay > afterLastWindowDay ? afterLastWindowDay : afterLastOccurrenceDay;

    for (let day = firstDay; day < afterLastDay; day = addDaysLocal(day, 1)) {
      if (rows.length >= max) return { rows, truncated: true };
      rows.push({ date: toDateKeyLocal(day), time: '00:00', durationMinutes: 1440, allDay: true });
    }
  }
  return { rows, truncated };
}

// Occurrences are materialized as plain rows rather than stored as our own
// recurrence_rule: an arbitrary ICS RRULE (BYDAY, BYSETPOS, exceptions, ...)
// doesn't map onto the app's own small daily/weekly/monthly/yearly model, and
// these events are sync-managed and never hand-edited, so there's no need to
// keep them re-expandable.
// The window is split at `now` (at today's midnight for all-day rows, which
// are per day) so the past and the future each spend their own caps.
/**
 * @param {any} event
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @param {number} max
 * @param {Map<string, Intl.DateTimeFormat>} formatters
 */
function eventOccurrences(event, windowStart, windowEnd, max, formatters) {
  return event.datetype === 'date'
    ? allDayOccurrences(event, windowStart, windowEnd, max)
    : timedOccurrences(event, windowStart, windowEnd, max, formatters);
}

/**
 * @param {string} icsText
 * @param {Date} windowStart
 * @param {Date} now
 * @param {Date} windowEnd
 * @returns {{rows: any[], truncated: boolean}}
 */
function parseEvents(icsText, windowStart, now, windowEnd) {
  const parsed = ical.parseICS(icsText);
  const formatters = new Map();
  const today = startOfLocalDay(now);
  const rows = [];
  let pastCount = 0;
  let futureCount = 0;
  let truncated = false;
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

    const split = value.datetype === 'date' ? today : now;
    const sides = [
      {
        from: windowStart,
        to: new Date(split.getTime() - 1),
        max: MAX_PAST_OCCURRENCES_PER_EVENT,
        room: MAX_PAST_EVENTS_PER_SYNC - pastCount,
        past: true,
      },
      {
        from: split,
        to: windowEnd,
        max: MAX_OCCURRENCES_PER_EVENT,
        room: MAX_EVENTS_PER_SYNC - futureCount,
        past: false,
      },
    ];
    for (const side of sides) {
      if (side.room <= 0) {
        // Only a side that still had occurrences to give is truncated.
        if (eventOccurrences(value, side.from, side.to, 1, formatters).rows.length > 0) {
          truncated = true;
        }
        continue;
      }
      const occurrences = eventOccurrences(value, side.from, side.to, side.max, formatters);
      if (occurrences.truncated) truncated = true;
      let added = 0;
      for (const occurrence of occurrences.rows) {
        if (!TIME_RE.test(occurrence.time)) continue;
        if (added >= side.room) {
          truncated = true;
          break;
        }
        rows.push({
          title,
          description,
          location,
          date: occurrence.date,
          start: occurrence.time,
          duration: occurrence.durationMinutes,
          all_day: occurrence.allDay,
        });
        added += 1;
      }
      if (side.past) pastCount += added;
      else futureCount += added;
    }
    if (truncated && pastCount >= MAX_PAST_EVENTS_PER_SYNC && futureCount >= MAX_EVENTS_PER_SYNC) {
      break;
    }
  }
  return { rows, truncated };
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
  let truncated;
  try {
    const icsText = await fetchIcs(url, request);
    ({ rows, truncated } = parseEvents(icsText, windowStart, now, windowEnd));
  } catch (error) {
    return recordSyncError(sql, calendarId, error);
  }
  if (truncated) {
    console.log(
      JSON.stringify({ event: 'calendar_sync_truncated', calendarId, count: rows.length }),
    );
  }
  const warning = truncated ? TRUNCATED_SYNC_WARNING : null;

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
      await tx`UPDATE calendars SET subscription_synced_at = now(), subscription_error = ${warning} WHERE id = ${calendarId}`;
    });
  } catch (error) {
    return recordSyncError(sql, calendarId, error);
  }
  return truncated
    ? { ok: true, count: rows.length, truncated: true, warning: TRUNCATED_SYNC_WARNING }
    : { ok: true, count: rows.length };
}
