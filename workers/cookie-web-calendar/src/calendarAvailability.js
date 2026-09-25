import ical from 'node-ical';
import { allowRequest } from '../../../shared/rate-limit.js';
import { expandEventsPage } from './recurrence.js';
import {
  calendarSubscriptionAllowlist,
  fetchIcs,
  requestPublicHttps,
  validSubscriptionUrl,
} from './calendarSync.js';
import {
  addDays,
  DAY_MS,
  mergeBusy,
  validDate,
  validTimeZone,
  wallClock,
  wallTimeToInstant,
} from './availabilityTime.js';
import { validId } from '../../../shared/pagination.js';

const MAX_ROWS = 1000;
const MAX_BUSY = 5000;
const MAX_DURATION = 30 * DAY_MS;
const INCOMPLETE =
  'Could not completely check this calendar. Try a shorter range or another calendar.';
// Each feed may be up to 5 MB of ICS text plus its parsed events. Fetching
// all ten selectable feeds at once could hold ~50 MB in one isolate, so only a
// few are in flight; each feed's text is dropped once reduced to intervals.
const FEED_CONCURRENCY = 3;

/**
 * Maps items with at most `limit` callbacks running at once, keeping order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} callback
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, callback) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await callback(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** @param {any} body */
export function validateAvailabilityRequest(body) {
  return (
    Array.isArray(body?.calendarIds) &&
    body.calendarIds.length > 0 &&
    body.calendarIds.length <= 10 &&
    body.calendarIds.every((/** @type {unknown} */ id) => typeof id === 'string' && validId(id)) &&
    new Set(body.calendarIds).size === body.calendarIds.length &&
    validDate(body.from) &&
    validDate(body.to) &&
    body.from <= body.to &&
    new Date(body.to).getTime() - new Date(body.from).getTime() < 31 * DAY_MS &&
    validTimeZone(body.timeZone) &&
    validTimeZone(body.interpretationTimeZone) &&
    body.confirmFloatingTimes === true
  );
}

/** @param {any[]} rows @param {any} body @param {{start: number, end: number}} window */
export function nativeBusyIntervals(rows, body, window) {
  if (rows.length > MAX_ROWS) throw new Error('Too many events');
  // Include long/cross-midnight events starting before the selected dates,
  // plus a two-day timezone margin. Do not use cached subscription rows.
  const range = { from: addDays(body.from, -32), to: addDays(body.to, 2) };
  for (const row of rows) {
    if (
      !validDate(row.date) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.start) ||
      !Number.isInteger(row.duration) ||
      row.duration <= 0 ||
      row.duration * 60_000 > MAX_DURATION ||
      (row.recurrenceRule &&
        !/^(DAILY|WEEKLY|MONTHLY|YEARLY)(?:;BYDAY=(?:SU|MO|TU|WE|TH|FR|SA)(?:,(?:SU|MO|TU|WE|TH|FR|SA)){0,6})?(?:;UNTIL=\d{4}-\d{2}-\d{2})?$/.test(
          row.recurrenceRule,
        ))
    )
      throw new Error('Unknown event timing');
    const until = row.recurrenceRule?.match(/;UNTIL=(.*)$/)?.[1];
    if (until && !validDate(until)) throw new Error('Invalid recurrence end');
    // The shared calendar expander predates availability and does not report
    // every per-series stepping cap. Keep this read strictly inside its
    // 10,000-step budget, including very old/monthly series.
    const months =
      (Number(range.to.slice(0, 4)) - Number(row.date.slice(0, 4))) * 12 +
      Number(range.to.slice(5, 7)) -
      Number(row.date.slice(5, 7));
    if (row.recurrenceRule?.startsWith('MONTHLY') && months > 9000)
      throw new Error('Recurrence exceeds safe expansion');
    if (row.recurrenceRule?.startsWith('YEARLY') && months > 9000 * 12)
      throw new Error('Recurrence exceeds safe expansion');
  }
  const page = expandEventsPage(rows, new Date(), range);
  if (page.truncated) throw new Error('Incomplete recurrence expansion');
  return page.events.flatMap((event) => {
    const start = wallTimeToInstant(
      event.date,
      event.allDay ? '00:00' : event.start,
      body.interpretationTimeZone,
    );
    const end = event.allDay
      ? wallTimeToInstant(
          addDays(event.date, Math.max(1, Math.ceil(event.duration / 1440))),
          '00:00',
          body.interpretationTimeZone,
        )
      : start + event.duration * 60_000;
    return start < window.end && end > window.start ? [{ start, end }] : [];
  });
}

/**
 * Reject recurrence constructs not completely supported by this bounded
 * reader. Inject the confirmed zone into truly floating DATE-TIME fields
 * before node-ical parses them. Feed/parser errors never leave this module.
 * @param {string} text
 * @param {string} zone
 */
function prepareFeed(text, zone) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  if (
    lines[0]?.trim() !== 'BEGIN:VCALENDAR' ||
    !lines.some((line) => line.trim() === 'END:VCALENDAR')
  )
    throw new Error('Invalid feed');
  let events = 0;
  let inEvent = false;
  let starts = 0;
  let rules = 0;
  /** @type {string[]} */
  const stack = [];
  let calendarCount = 0;
  const result = lines.map((line) => {
    const boundary = /^(BEGIN|END):([A-Z0-9-]+)$/i.exec(line);
    if (boundary) {
      const name = boundary[2].toUpperCase();
      if (boundary[1].toUpperCase() === 'BEGIN') {
        const parent = stack.at(-1);
        const allowed =
          name === 'VCALENDAR'
            ? !parent && ++calendarCount === 1
            : name === 'VEVENT' || name === 'VTIMEZONE'
              ? parent === 'VCALENDAR'
              : name === 'STANDARD' || name === 'DAYLIGHT'
                ? parent === 'VTIMEZONE'
                : name === 'VALARM' && parent === 'VEVENT';
        if (!allowed) throw new Error('Unsupported calendar component');
        stack.push(name);
      } else if (stack.pop() !== name) throw new Error('Incomplete feed');
      line = `${boundary[1].toUpperCase()}:${name}`;
    } else if (/^(BEGIN|END):/i.test(line)) throw new Error('Invalid calendar component');
    if (/^CALSCALE:/i.test(line) && line.toUpperCase() !== 'CALSCALE:GREGORIAN')
      throw new Error('Unsupported calendar scale');
    if (/^BEGIN:VFREEBUSY$/i.test(line)) throw new Error('Unsupported free/busy component');
    if (/^BEGIN:VEVENT$/i.test(line)) {
      if (inEvent) throw new Error('Incomplete feed');
      events += 1;
      inEvent = true;
      starts = 0;
      rules = 0;
      line = 'BEGIN:VEVENT';
    }
    if (events > MAX_ROWS) throw new Error('Too many feed events');
    if (/^END:VEVENT$/i.test(line)) {
      if (!inEvent) throw new Error('Incomplete feed');
      if (starts !== 1) throw new Error('Missing event start');
      inEvent = false;
      line = 'END:VEVENT';
    }
    if (/^DURATION(?:[;:]|$)/i.test(line)) {
      // node-ical adds nominal days/weeks as elapsed UTC time and logs raw
      // malformed values. Validate before parsing, including nested components,
      // and support only bounded, positive elapsed hour/minute/second values.
      const duration =
        /^DURATION(?:;VALUE=DURATION)?:\+?PT(?:(\d{1,10})H)?(?:(\d{1,10})M)?(?:(\d{1,10})S)?$/i.exec(
          line,
        );
      const seconds = duration
        ? Number(duration[1] || 0) * 3600 + Number(duration[2] || 0) * 60 + Number(duration[3] || 0)
        : 0;
      if (seconds <= 0 || seconds * 1000 > MAX_DURATION)
        throw new Error('Unsupported event duration');
      return line.toUpperCase();
    }
    if (!inEvent || stack.at(-1) !== 'VEVENT') return line;
    if (/^(RDATE|EXRULE)[;:]/i.test(line) || /;RANGE=/i.test(line))
      throw new Error('Unsupported recurrence');
    if (/^RRULE:/i.test(line)) {
      rules += 1;
      if (
        rules > 1 ||
        !/^RRULE:FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;|$)/i.test(line) ||
        /;(BYSECOND|BYMINUTE|BYHOUR|RSCALE|SKIP)=/i.test(line)
      )
        throw new Error('Unsupported recurrence');
      return line.toUpperCase();
    }
    const match = /^(DTSTART|DTEND|RECURRENCE-ID|EXDATE)((?:;[^:]*)?):(.*)$/i.exec(line);
    if (!match) return line;
    if (match[1].toUpperCase() === 'DTSTART') starts += 1;
    const tzid = /;TZID=(?:"([^"]+)"|([^;]+))/i.exec(match[2]);
    const sourceZone = tzid ? tzid[1] || tzid[2] : zone;
    if (!validTimeZone(sourceZone)) throw new Error('Unknown source timezone');
    const values = match[3].split(',');
    if (
      values.some((value) => value.endsWith('Z')) &&
      (tzid || values.some((value) => !value.endsWith('Z')))
    )
      throw new Error('Mixed date timezones');
    for (const value of values) {
      if (!/^\d{8}(?:T\d{6}Z?)?$/.test(value)) throw new Error('Unknown date value');
      const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
      if (!validDate(date) || date < '1970-01-01') throw new Error('Unsupported event date');
      if (value.length > 8 && !/^([01]\d|2[0-3])[0-5]\d[0-5]\dZ?$/.test(value.slice(9)))
        throw new Error('Invalid event time');
      if (value.length > 8 && !value.endsWith('Z'))
        wallTimeToInstant(
          date,
          `${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`,
          sourceZone,
        );
    }
    return !tzid &&
      /^\d{8}T/.test(match[3]) &&
      !match[3].split(',').some((value) => value.endsWith('Z'))
      ? `${match[1].toUpperCase()}${match[2]};TZID=${zone}:${match[3]}`
      : `${match[1].toUpperCase()}${match[2]}:${match[3]}`;
  });
  if (inEvent || stack.length || calendarCount !== 1) throw new Error('Incomplete feed');
  return result.join('\r\n');
}

/** @param {string} text @param {any} body @param {{start: number, end: number}} window */
export function subscriptionBusyIntervals(text, body, window) {
  const parsed = ical.parseICS(prepareFeed(text, body.interpretationTimeZone));
  /** @type {{start: number, end: number}[]} */
  const busy = [];
  for (const event of /** @type {any[]} */ (Object.values(parsed))) {
    if (event.type !== 'VEVENT') continue;
    if (!(event.start instanceof Date) || !(event.end instanceof Date))
      throw new Error('Unknown event duration');
    if (event.end - event.start < 0 || event.end - event.start > MAX_DURATION)
      throw new Error('Unsupported duration');
    for (const override of /** @type {any[]} */ (Object.values(event.recurrences || {}))) {
      if ((override.datetype === 'date') !== (event.datetype === 'date'))
        throw new Error('Unsupported mixed recurrence timing');
    }
    // Date-only events have no instant until interpreted. The margin also
    // covers offsets of an override that crosses the requested boundary.
    const instances = ical.expandRecurringEvent(event, {
      from: new Date(window.start - 2 * DAY_MS),
      to: new Date(window.end + 2 * DAY_MS),
      expandOngoing: true,
    });
    if (instances.length + busy.length > MAX_BUSY) throw new Error('Too many occurrences');
    for (const instance of instances) {
      const source = /** @type {any} */ (instance).event;
      if (
        (source?.status ?? event.status) === 'CANCELLED' ||
        (source?.transparency ?? event.transparency) === 'TRANSPARENT'
      )
        continue;
      let start = instance.start.getTime();
      let end = instance.end.getTime();
      if (instance.isFullDay) {
        const localDate = (/** @type {Date} */ date) =>
          `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        start = wallTimeToInstant(localDate(instance.start), '00:00', body.interpretationTimeZone);
        end = wallTimeToInstant(localDate(instance.end), '00:00', body.interpretationTimeZone);
      } else {
        const sourceZone = source?.start?.tz || event.start.tz;
        if (!validTimeZone(sourceZone)) throw new Error('Unknown timezone');
        const wall = wallClock(sourceZone)(start);
        if (wallTimeToInstant(wall.slice(0, 10), wall.slice(11), sourceZone) !== start)
          throw new Error('Unknown source instant');
      }
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        end - start > MAX_DURATION + DAY_MS
      )
        throw new Error('Unknown busy interval');
      if (start < window.end && end > window.start) busy.push({ start, end });
    }
  }
  return busy;
}

/**
 * Authenticated read only. No event details or private feed URLs are returned.
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {import('./sentry.js').CalendarEnv} env
 * @param {typeof requestPublicHttps} [request]
 */
export async function calendarAvailability(sql, userId, body, env, request = requestPublicHttps) {
  const response = (/** @type {any} */ value, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  if (!validateAvailabilityRequest(body))
    return response(
      {
        error:
          'Choose 1–10 calendars, a range of at most 31 days, valid timezones, and confirm the calendar timezone.',
      },
      400,
    );
  let window;
  try {
    window = {
      start: wallTimeToInstant(body.from, '00:00', body.timeZone),
      end: wallTimeToInstant(addDays(body.to, 1), '00:00', body.timeZone),
    };
  } catch {
    return response(
      { error: 'This date range has an ambiguous or nonexistent midnight in the chosen timezone.' },
      400,
    );
  }
  if (!(await allowRequest(sql, userId, 'calendar-availability', { limit: 10, windowMs: 60_000 })))
    return response({ error: 'Too many availability checks. Try again in a minute.' }, 429);
  const calendars = await sql`
    SELECT id, subscription_url AS "subscriptionUrl", subscription_synced_at AS "subscriptionSyncedAt", subscription_error AS "subscriptionError"
    FROM calendars WHERE user_id = ${userId} AND id::text = ANY(${body.calendarIds}::text[])
  `;
  if (calendars.length !== body.calendarIds.length)
    return response({ error: 'Selected calendars are unavailable.' }, 404);
  const nativeIds = calendars.filter((c) => !c.subscriptionUrl).map((c) => c.id);
  /** @type {{start: number, end: number}[]} */
  const busy = [];
  const sources = [];
  if (nativeIds.length) {
    try {
      const rows = await sql`
        SELECT id, event_date AS date, start_time AS start, duration_minutes AS duration, recurrence_rule AS "recurrenceRule", all_day AS "allDay"
        FROM calendar_events WHERE user_id = ${userId} AND calendar::text = ANY(${nativeIds}::text[])
          AND (recurrence_rule IS NOT NULL OR event_date BETWEEN ${addDays(body.from, -32)} AND ${addDays(body.to, 2)})
        LIMIT ${MAX_ROWS + 1}
      `;
      busy.push(...nativeBusyIntervals(rows, body, window));
      sources.push(...nativeIds.map((id) => ({ id, complete: true, kind: 'native' })));
    } catch {
      sources.push(
        ...nativeIds.map((id) => ({ id, complete: false, kind: 'native', error: INCOMPLETE })),
      );
    }
  }
  const feeds = await mapWithConcurrency(
    calendars.filter((c) => c.subscriptionUrl),
    FEED_CONCURRENCY,
    async (calendar) => {
      const status = {
        id: calendar.id,
        kind: 'subscription',
        subscriptionSyncedAt: calendar.subscriptionSyncedAt,
        cachedSyncFailed: Boolean(calendar.subscriptionError),
      };
      try {
        const url = validSubscriptionUrl(
          calendar.subscriptionUrl,
          calendarSubscriptionAllowlist(env),
        );
        if (!url) throw new Error('Subscription not allowed');
        const intervals = subscriptionBusyIntervals(await fetchIcs(url, request), body, window);
        return {
          status: { ...status, complete: true, checkedAt: new Date().toISOString() },
          intervals,
        };
      } catch {
        // Deliberately omit remote error details: they may contain private URLs
        // or feed content, including when the parser itself throws.
        return { status: { ...status, complete: false, error: INCOMPLETE }, intervals: [] };
      }
    },
  );
  for (const feed of feeds) {
    sources.push(feed.status);
    busy.push(...feed.intervals);
  }
  const complete = sources.every((source) => source.complete) && busy.length <= MAX_BUSY;
  return response({
    complete,
    busy: complete ? mergeBusy(busy) : [],
    sources,
    window,
    checkedAt: new Date().toISOString(),
    ...(complete ? {} : { error: 'Availability is incomplete. No times can be suggested.' }),
  });
}
