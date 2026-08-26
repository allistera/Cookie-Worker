// Ported from Cookie-Web's api/calendar-events.js (the event-CRUD half; the
// recurrence expansion lives in recurrence.js). Behaviorally identical —
// same queries, validation, migration-window fallbacks, and status codes;
// only the (req, res) mutation style becomes returning a Response.

import { allowRequest } from '../../../shared/rate-limit.js';
import {
  buildRecurrenceRule,
  expandEventsPage,
  parseRangeParams,
  WEEKDAY_CODES,
} from './recurrence.js';
import { generateCalendarEventDraft } from './calendarAi.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MAX_TITLE = 200;
const MAX_LOCATION = 200;
const MAX_DESCRIPTION = 2000;
const MAX_AI_EVENT_TEXT = 1000;
const AI_RATE_LIMIT = { limit: 10, windowMs: 60_000 };
// The schema CHECK only enforces duration > 0; this upper bound stops an
// absurd value (e.g. 2e9 minutes ≈ 3800 years) from rendering as a giant
// block in every client that trusts the stored duration.
const MAX_DURATION_MINUTES = 30 * 24 * 60;
const LEGACY_CALENDAR_NAMES = new Map([
  ['work', 'Work'],
  ['personal', 'Personal'],
  ['focus', 'Focus time'],
  ['birthdays', 'Birthdays'],
  ['holidays', 'Holidays'],
]);
const ALLOWED_TONES = new Set(['default', 'dark', 'conflict', 'accepted', 'suggested']);
const REPEAT_FREQUENCIES = new Set(['none', 'daily', 'weekly', 'monthly', 'yearly']);

/** @param {any} body */
function validEventFields(body) {
  const title = String(body.title ?? '').trim();
  const description = String(body.description ?? '').trim() || null;
  const location = String(body.location ?? '').trim() || null;
  const date = String(body.date ?? '');
  const start = String(body.start ?? '');
  const duration = Number.isFinite(body.duration) ? Math.trunc(body.duration) : 0;
  const calendar = String(body.calendar ?? '');
  const tone = body.tone === null || body.tone === undefined ? null : String(body.tone);
  const repeat = String(body.repeat ?? 'none');
  const repeatUntil = String(body.repeatUntil ?? '') || null;
  const repeatDaysRaw = Array.isArray(body.repeatDays) ? body.repeatDays : null;

  if (
    !title ||
    title.length > MAX_TITLE ||
    !DATE_RE.test(date) ||
    !TIME_RE.test(start) ||
    duration <= 0 ||
    duration > MAX_DURATION_MINUTES ||
    !(UUID_RE.test(calendar) || LEGACY_CALENDAR_NAMES.has(calendar)) ||
    (tone !== null && !ALLOWED_TONES.has(tone)) ||
    (location && location.length > MAX_LOCATION) ||
    (description && description.length > MAX_DESCRIPTION) ||
    !REPEAT_FREQUENCIES.has(repeat) ||
    (repeatUntil && !DATE_RE.test(repeatUntil)) ||
    (repeatDaysRaw &&
      (repeat !== 'weekly' ||
        repeatDaysRaw.length === 0 ||
        repeatDaysRaw.some((/** @type {string} */ day) => !WEEKDAY_CODES.includes(day))))
  ) {
    return null;
  }
  // Stored in a fixed week order regardless of the order the client sent, so
  // the recurrence_rule string stays stable/comparable across edits.
  const repeatDays = repeatDaysRaw
    ? WEEKDAY_CODES.filter((code) => repeatDaysRaw.includes(code))
    : null;
  const recurrenceRule = buildRecurrenceRule(
    repeat,
    repeat === 'none' ? null : repeatUntil,
    repeatDays,
  );
  return { title, description, location, date, start, duration, calendar, tone, recurrenceRule };
}

// A calendar id in the request body must actually belong to the caller —
// otherwise any authenticated user could file events under another user's
// calendar id (or a nonexistent one). Migration 0024 installs the composite FK
// that makes this ownership check authoritative in the database and closes
// resolve-then-write races.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} calendarId
 */
async function resolveCalendarId(sql, userId, calendarId) {
  const legacyName = LEGACY_CALENDAR_NAMES.get(calendarId) ?? null;
  try {
    const [row] = await sql`
      SELECT c.id, c.subscription_url AS "subscriptionUrl"
      FROM calendars c
      WHERE c.user_id = ${userId}
        AND (c.id::text = ${calendarId} OR c.name = ${legacyName})
      LIMIT 1
    `;
    return row ? { id: row.id, subscriptionUrl: row.subscriptionUrl } : null;
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code === '42703') {
      // Migration 0026 (subscription columns) hasn't landed yet; the table
      // itself is fine, so retry without referencing them.
      const [row] = await sql`
        SELECT c.id
        FROM calendars c
        WHERE c.user_id = ${userId}
          AND (c.id::text = ${calendarId} OR c.name = ${legacyName})
        LIMIT 1
      `;
      return row ? { id: row.id, subscriptionUrl: null } : null;
    }
    // During the expand rollout, the new API may be live briefly before the
    // calendars table exists. Legacy slugs remain valid until migration 0024.
    if (/** @type {{code?: string}} */ (error)?.code === '42P01')
      return legacyName ? { id: calendarId, subscriptionUrl: null } : null;
    throw error;
  }
}

// The range filter keeps recurring masters unconditionally: a series row's
// event_date is its start, not its span, so a years-old weekly series must
// still reach expandEvents, which clips its occurrences to the range. A
// missing range binds the full date domain, preserving return-everything
// behavior for callers that don't window (the pre-range wire contract).
const RANGE_MIN = '0001-01-01';
const RANGE_MAX = '9999-12-31';

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{from: string, to: string} | null} range
 */
async function fetchNormalizedEvents(sql, userId, range) {
  return sql`
    SELECT ce.id, ce.title, ce.description, ce.location, ce.event_date AS date,
           ce.start_time AS start, ce.duration_minutes AS duration,
           COALESCE(c.id::text, ce.calendar::text) AS calendar, ce.tone,
           ce.recurrence_rule AS "recurrenceRule", ce.all_day AS "allDay",
           ce.is_auto_scheduled AS "autoScheduled"
    FROM calendar_events ce
    LEFT JOIN calendars c
      ON c.user_id = ce.user_id
     AND (
       c.id::text = ce.calendar::text
       OR c.name = CASE ce.calendar::text
         WHEN 'work' THEN 'Work'
         WHEN 'personal' THEN 'Personal'
         WHEN 'focus' THEN 'Focus time'
         WHEN 'birthdays' THEN 'Birthdays'
         WHEN 'holidays' THEN 'Holidays'
       END
     )
    WHERE ce.user_id = ${userId}
      AND (ce.recurrence_rule IS NOT NULL
           OR ce.event_date BETWEEN ${range?.from ?? RANGE_MIN} AND ${range?.to ?? RANGE_MAX})
    ORDER BY ce.event_date, ce.start_time
  `;
}

// Same as fetchNormalizedEvents, minus recurrence_rule and all_day — used
// while migrations 0025/0027 haven't landed yet on a database this deploy is
// already talking to.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{from: string, to: string} | null} range
 */
async function fetchNormalizedEventsWithoutRecurrence(sql, userId, range) {
  return sql`
    SELECT ce.id, ce.title, ce.description, ce.location, ce.event_date AS date,
           ce.start_time AS start, ce.duration_minutes AS duration,
           COALESCE(c.id::text, ce.calendar::text) AS calendar, ce.tone
    FROM calendar_events ce
    LEFT JOIN calendars c
      ON c.user_id = ce.user_id
     AND (
       c.id::text = ce.calendar::text
       OR c.name = CASE ce.calendar::text
         WHEN 'work' THEN 'Work'
         WHEN 'personal' THEN 'Personal'
         WHEN 'focus' THEN 'Focus time'
         WHEN 'birthdays' THEN 'Birthdays'
         WHEN 'holidays' THEN 'Holidays'
       END
     )
    WHERE ce.user_id = ${userId}
      AND ce.event_date BETWEEN ${range?.from ?? RANGE_MIN} AND ${range?.to ?? RANGE_MAX}
    ORDER BY ce.event_date, ce.start_time
  `;
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{from: string, to: string} | null} [range]
 */
export async function fetchEvents(sql, userId, range = null) {
  try {
    return await fetchNormalizedEvents(sql, userId, range);
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code;
    if (code === '42703') return fetchNormalizedEventsWithoutRecurrence(sql, userId, range);
    if (code !== '42P01') throw error;
    return sql`
      SELECT ce.id, ce.title, ce.description, ce.location, ce.event_date AS date,
             ce.start_time AS start, ce.duration_minutes AS duration, ce.calendar, ce.tone
      FROM calendar_events ce
      WHERE ce.user_id = ${userId}
        AND ce.event_date BETWEEN ${range?.from ?? RANGE_MIN} AND ${range?.to ?? RANGE_MAX}
      ORDER BY ce.event_date, ce.start_time
    `;
  }
}

const READ_ONLY_ERROR = 'This calendar is read-only — its events sync automatically.';

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} eventId
 */
async function isEventInSubscribedCalendar(sql, userId, eventId) {
  try {
    const [row] = await sql`
      SELECT c.subscription_url IS NOT NULL AS "isSubscribed"
      FROM calendar_events ce
      LEFT JOIN calendars c ON c.id = ce.calendar
      WHERE ce.id = ${eventId} AND ce.user_id = ${userId}
    `;
    return row?.isSubscribed ?? false;
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code === '42703') return false; // migration 0026 hasn't landed yet
    throw error;
  }
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 */
export async function listEvents(sql, userId, url) {
  const { range, error } = parseRangeParams(url.searchParams);
  if (error || !range) {
    return Response.json({ error: 'from and to must be a valid YYYY-MM-DD pair' }, { status: 400 });
  }
  const events = await fetchEvents(sql, userId, range);
  const { events: expanded, truncated } = expandEventsPage(events, new Date(), range);
  return Response.json({ events: expanded, truncated });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function createEvent(sql, userId, body) {
  const fields = validEventFields(body);
  if (!fields) {
    return Response.json({ error: 'Invalid event fields' }, { status: 400 });
  }
  const calendar = await resolveCalendarId(sql, userId, fields.calendar);
  if (!calendar) {
    return Response.json({ error: 'Calendar not found' }, { status: 404 });
  }
  if (calendar.subscriptionUrl) {
    return Response.json({ error: READ_ONLY_ERROR }, { status: 403 });
  }

  // WHERE EXISTS keeps the graceful 404 (rather than an FK-violation error)
  // for the theoretical race where the user row is deleted between
  // verifyAccessToken and this insert, without re-deriving userId via email.
  const [event] = await sql`
    INSERT INTO calendar_events
      (user_id, title, description, location, event_date, start_time, duration_minutes, calendar, tone, recurrence_rule, all_day)
    SELECT ${userId}, ${fields.title}, ${fields.description}, ${fields.location}, ${fields.date},
           ${fields.start}, ${fields.duration}, ${calendar.id}, ${fields.tone}, ${fields.recurrenceRule}, false
    WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId})
    RETURNING id, title, description, location, event_date AS date, start_time AS start,
              duration_minutes AS duration, calendar, tone, recurrence_rule AS "recurrenceRule", all_day AS "allDay",
              is_auto_scheduled AS "autoScheduled"
  `;
  if (!event) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }
  return Response.json({ event }, { status: 201 });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function updateEvent(sql, userId, body) {
  const id = UUID_RE.test(body.id) ? String(body.id) : null;
  const fields = id ? validEventFields(body) : null;
  if (!fields) {
    return Response.json({ error: 'id and valid event fields are required' }, { status: 400 });
  }
  // Independent lookups — the target calendar (from fields.calendar) and the
  // event's current calendar (from id) — so they run concurrently instead of
  // as two sequential round trips.
  const [calendar, eventInSubscribedCalendar] = await Promise.all([
    resolveCalendarId(sql, userId, fields.calendar),
    isEventInSubscribedCalendar(sql, userId, /** @type {string} */ (id)),
  ]);
  if (!calendar) {
    return Response.json({ error: 'Calendar not found' }, { status: 404 });
  }
  if (calendar.subscriptionUrl || eventInSubscribedCalendar) {
    return Response.json({ error: READ_ONLY_ERROR }, { status: 403 });
  }

  const [event] = await sql`
    UPDATE calendar_events ce
    SET title = ${fields.title},
        description = ${fields.description},
        location = ${fields.location},
        event_date = ${fields.date},
        start_time = ${fields.start},
        duration_minutes = ${fields.duration},
        calendar = ${calendar.id},
        tone = ${fields.tone},
        recurrence_rule = ${fields.recurrenceRule},
        all_day = false,
        updated_at = now()
    WHERE ce.id = ${id} AND ce.user_id = ${userId}
    RETURNING ce.id, ce.title, ce.description, ce.location, ce.event_date AS date,
              ce.start_time AS start, ce.duration_minutes AS duration, ce.calendar, ce.tone,
              ce.recurrence_rule AS "recurrenceRule", ce.all_day AS "allDay",
              ce.is_auto_scheduled AS "autoScheduled"
  `;
  if (!event) {
    return Response.json({ error: 'Event not found' }, { status: 404 });
  }
  return Response.json({ event });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function deleteEvent(sql, userId, body) {
  const id = UUID_RE.test(body.id) ? String(body.id) : null;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }
  if (await isEventInSubscribedCalendar(sql, userId, id)) {
    return Response.json({ error: READ_ONLY_ERROR }, { status: 403 });
  }
  const rows = await sql`
    DELETE FROM calendar_events ce
    WHERE ce.id = ${id} AND ce.user_id = ${userId}
    RETURNING ce.id
  `;
  if (rows.length === 0) {
    return Response.json({ error: 'Event not found' }, { status: 404 });
  }
  return Response.json({ ok: true });
}

/** @param {unknown} value */
function validTimeZone(value) {
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

/**
 * POST /calendar-events with action=interpret — natural language to a
 * reviewable event draft.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {{OPENAI_API_KEY?: string, OPENAI_CALENDAR_MODEL?: string, OPENAI_COMPOSE_MODEL?: string}} env
 * @param {{generator?: (input: {text: string, now: string, timeZone: string}, apiKey: string, fetchImpl?: any, env?: any) => Promise<any>, now?: () => Date}} [overrides]
 */
export async function interpretEvent(sql, userId, body, env, overrides = {}) {
  const generator = overrides.generator ?? generateCalendarEventDraft;
  const now = overrides.now ?? (() => new Date());
  const text = String(body.text ?? '').trim();
  const timeZone = validTimeZone(body.timeZone);
  if (!text || text.length > MAX_AI_EVENT_TEXT || !timeZone) {
    return Response.json({ error: 'text and a valid time zone are required' }, { status: 400 });
  }
  if (!env.OPENAI_API_KEY) {
    return Response.json({ error: 'AI calendar creation is not configured' }, { status: 503 });
  }

  let allowed;
  try {
    allowed = await allowRequest(sql, userId, 'ai', AI_RATE_LIMIT);
  } catch (error) {
    console.error(
      'POST /calendar-events AI quota enforcement failed:',
      /** @type {Error} */ (error).message,
    );
    return Response.json(
      { error: 'AI calendar creation is temporarily unavailable' },
      { status: 503 },
    );
  }
  if (!allowed) {
    return Response.json({ error: 'Too many AI requests, slow down' }, { status: 429 });
  }

  try {
    const result = await generator(
      { text, now: now().toISOString(), timeZone },
      env.OPENAI_API_KEY,
      fetch,
      env,
    );
    return Response.json(result);
  } catch (error) {
    console.error('POST /calendar-events AI interpretation failed:', error);
    return Response.json({ error: 'AI calendar creation failed' }, { status: 502 });
  }
}
