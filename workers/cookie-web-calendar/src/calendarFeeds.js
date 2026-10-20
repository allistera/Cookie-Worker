import { validId } from '../../../shared/pagination.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { allowRequest } from '../../../shared/rate-limit.js';
import { WEEKDAY_CODES } from './recurrence.js';

export const FEED_PATH = '/calendar-feed.ics';
const TOKEN_RE = /^[0-9a-f]{64}$/;
const MAX_EVENTS = 10_000;
const encoder = new TextEncoder();
const privateHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { ...privateHeaders, ...headers } });
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function digest(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

// The management endpoint uses the normal verified Cookie identity. Returning
// status separately keeps both raw tokens and their hashes out of /calendars.
export async function manageCalendarFeeds(sql, userId, request) {
  try {
    if (request.method === 'GET') {
      const feeds = await sql`
        SELECT f.calendar_id AS "calendarId"
        FROM calendar_feeds f JOIN calendars c
          ON c.id = f.calendar_id AND c.user_id = f.user_id
        WHERE f.user_id = ${userId} AND c.subscription_url IS NULL
      `;
      return json({ feeds });
    }
    if (request.method !== 'POST' && request.method !== 'DELETE') {
      return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST, DELETE' });
    }
    const body = /** @type {any} */ (await readJsonBody(request));
    if (!validId(body?.calendarId)) return json({ error: 'calendarId is required' }, 400);

    if (request.method === 'DELETE') {
      await sql`
        DELETE FROM calendar_feeds WHERE calendar_id = ${body.calendarId} AND user_id = ${userId}
      `;
      return json({ ok: true });
    }
    if (
      !(await allowRequest(sql, userId, 'calendar-feed-create', { limit: 20, windowMs: 60_000 }))
    ) {
      return json({ error: 'Too many requests. Try again shortly.' }, 429, { 'Retry-After': '60' });
    }
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await digest(token);
    // One statement validates ownership and excludes subscribed calendars.
    // Replacing the digest immediately invalidates the previous link.
    const [feed] = await sql`
      INSERT INTO calendar_feeds (calendar_id, user_id, token_hash)
      SELECT c.id, c.user_id, ${tokenHash} FROM calendars c
      WHERE c.id = ${body.calendarId} AND c.user_id = ${userId} AND c.subscription_url IS NULL
      ON CONFLICT (calendar_id) DO UPDATE
        SET token_hash = EXCLUDED.token_hash, created_at = now()
        WHERE calendar_feeds.user_id = EXCLUDED.user_id
      RETURNING calendar_id AS "calendarId"
    `;
    if (!feed) return json({ error: 'Calendar not found' }, 404);
    return json({ calendarId: feed.calendarId, token }, 201);
  } catch (error) {
    const invalidBody = bodyErrorResponse(error);
    if (invalidBody) {
      return json({ error: (await invalidBody.json()).error }, invalidBody.status);
    }
    if (/** @type {{code?: string}} */ (error)?.code === '42P01') {
      return json({ error: 'Calendar feeds are being upgraded. Try again shortly.' }, 503);
    }
    throw error;
  }
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[,;]/g, '\\$&');
}

// RFC 5545 folds at 75 UTF-8 octets, including the continuation space. Walk
// code points rather than UTF-16 units so emoji and non-Latin names survive.
function foldLine(value) {
  const lines = [];
  let line = '';
  let bytes = 0;
  for (const character of value) {
    const length = encoder.encode(character).length;
    if (bytes + length > 75) {
      lines.push(line);
      line = ' ';
      bytes = 1;
    }
    line += character;
    bytes += length;
  }
  lines.push(line);
  return lines.join('\r\n');
}

function dateTime(date) {
  return date.toISOString().replace(/[-:]/g, '').slice(0, 15);
}

function eventLines(event) {
  // UTC arithmetic only: stored native times are floating wall times, not
  // UTC instants. The exported DTSTART/DTEND intentionally have no Z/TZID.
  const start = new Date(`${event.date}T${event.allDay ? '00:00' : event.start}:00Z`);
  const parts = String(event.recurrenceRule ?? '').split(';');
  const frequency = parts[0];
  const byday = parts.find((part) => part.startsWith('BYDAY='))?.slice(6);
  const until = parts.find((part) => part.startsWith('UNTIL='))?.slice(6);
  if (byday) {
    const weekdays = byday.split(',');
    while (!weekdays.includes(WEEKDAY_CODES[start.getUTCDay()])) {
      start.setUTCDate(start.getUTCDate() + 1);
    }
  }
  if (until && start.toISOString().slice(0, 10) > until) return [];
  const end = new Date(
    start.getTime() +
      (event.allDay ? Math.max(1, Math.ceil(event.duration / 1440)) * 1440 : event.duration) *
        60_000,
  );
  const stamp = `${dateTime(new Date(event.updatedAt))}Z`;
  const lines = [
    'BEGIN:VEVENT',
    `UID:${event.id}@cookie.calendar`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    `DTSTART${event.allDay ? ';VALUE=DATE' : ''}:${dateTime(start).slice(0, event.allDay ? 8 : 15)}`,
    `DTEND${event.allDay ? ';VALUE=DATE' : ''}:${dateTime(end).slice(0, event.allDay ? 8 : 15)}`,
    `SUMMARY:${escapeText(event.title)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (frequency) {
    // Cookie clamps month ends (31 Jan -> 28 Feb -> 31 Mar) and leap-day
    // anniversaries. A bare RFC MONTHLY/YEARLY rule would skip those dates.
    let rule = `FREQ=${byday ? 'WEEKLY' : frequency}`;
    if (byday) rule += `;BYDAY=${byday}`;
    else if (frequency === 'MONTHLY' && start.getUTCDate() >= 29) {
      rule += `;BYMONTHDAY=${start.getUTCDate()},-1;BYSETPOS=1`;
    } else if (frequency === 'YEARLY' && start.getUTCMonth() === 1 && start.getUTCDate() === 29) {
      rule += ';BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1';
    }
    if (until) rule += `;UNTIL=${until.replace(/-/g, '')}${event.allDay ? '' : 'T235959'}`;
    lines.push(`RRULE:${rule}`);
  }
  lines.push('END:VEVENT');
  return lines;
}

export function serializeCalendar(name, events) {
  return (
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Cookie//Calendar subscription//EN',
      'CALSCALE:GREGORIAN',
      `X-WR-CALNAME:${escapeText(name)}`,
      ...events.flatMap(eventLines),
      'END:VCALENDAR',
    ]
      .map(foldLine)
      .join('\r\n') + '\r\n'
  );
}

// No browser session is required: possession of this single-calendar token
// grants read access only. Never pass the URL/token to logs or error reports.
export async function readCalendarFeed(sql, request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
  }
  const token = new URL(request.url).searchParams.get('token') ?? '';
  if (!TOKEN_RE.test(token)) return new Response(null, { status: 404, headers: privateHeaders });
  const tokenHash = await digest(token);
  // Authentication, calendar metadata and events share one database snapshot.
  // An empty calendar still has one row through the LEFT JOIN. No UI range,
  // recurrence expansion, imported feed, or Google overlay enters the export.
  const rows = await sql`
    SELECT c.name AS "calendarName", ce.id, ce.title, ce.description, ce.location,
           ce.event_date AS date, ce.start_time AS start, ce.duration_minutes AS duration,
           ce.all_day AS "allDay", ce.recurrence_rule AS "recurrenceRule",
           ce.updated_at AS "updatedAt"
    FROM calendar_feeds f
    JOIN calendars c ON c.id = f.calendar_id AND c.user_id = f.user_id
    LEFT JOIN calendar_events ce ON ce.calendar = c.id AND ce.user_id = c.user_id
    WHERE f.token_hash = ${tokenHash} AND c.subscription_url IS NULL
    ORDER BY ce.id
    LIMIT ${MAX_EVENTS + 1}
  `;
  if (!rows.length) return new Response(null, { status: 404, headers: privateHeaders });
  // Never publish a truncated calendar: clients may interpret omissions as
  // deletions. Keep work bounded and ask the client to retry instead.
  if (rows.length > MAX_EVENTS) {
    return new Response(null, {
      status: 503,
      headers: { ...privateHeaders, 'Retry-After': '3600' },
    });
  }
  const content = serializeCalendar(
    rows[0].calendarName,
    rows.filter((row) => row.id),
  );
  const etag = `"${await digest(content)}"`;
  const headers = {
    ...privateHeaders,
    'Cache-Control': 'private, no-cache, must-revalidate',
    'CDN-Cache-Control': 'no-store',
    'Content-Type': 'text/calendar; charset=utf-8',
    ETag: etag,
  };
  const validators = (request.headers.get('If-None-Match') ?? '')
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''));
  if (validators.includes(etag) || validators.includes('*')) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : content, { headers });
}
