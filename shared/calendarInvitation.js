// Calendar invitations (iTIP REQUEST/CANCEL received by email) and the
// calendar entries made from them. cookie-web-messages records each revision
// when the mail is read; cookie-web-send answers the organiser. Both keep the
// linked calendar_events rows in step through this module, so an invitation
// never holds more than one set of entries (migration 0113's unique index on
// invitation_id + event_date backs that up in the database).

import { normaliseAddress, senderIdentity } from './outOfOffice.js';

export const INVITATION_RESPONSES = ['accepted', 'tentative', 'declined'];

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
// calendar_events only bounds duration from below; match the API's own cap.
const MAX_DURATION_MINUTES = 30 * 24 * 60;
// An all-day invitation is stored as one row per day it covers.
const MAX_ALL_DAY_ROWS = 31;
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const SIMPLE_FREQUENCIES = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/**
 * The one address Cookie can send as. An invitation can only be answered for
 * this address: a reply for any other guest would not come from that guest.
 * @param {{EMAIL_FROM?: string}} env
 * @returns {string | null}
 */
export function invitationSender(env) {
  const from = String(env?.EMAIL_FROM ?? '').trim();
  return from ? senderIdentity(from) : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function validInvitationTimeZone(value) {
  const timeZone = String(value ?? '');
  if (!timeZone || timeZone.length > 100) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** @param {number} value */
const pad2 = (value) => String(value).padStart(2, '0');

/** @param {Date} date */
const utcDateKey = (date) =>
  `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;

/**
 * The wall-clock date and time of an instant in a time zone.
 * @param {Date} date
 * @param {string} timeZone
 */
function wallClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (/** @type {string} */ type) => parts.find((part) => part.type === type)?.value;
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  };
}

/**
 * An invitation's RRULE in the small rule format calendar_events stores
 * (cookie-web-calendar's recurrence.js): a frequency, optional weekdays for a
 * weekly series and an optional last day. Anything richer (an interval, a
 * count, "the second Tuesday") has no equivalent there and returns null.
 *
 * `day` is the first occurrence's date where the event is shown and
 * `sourceDay` its date in the organiser's zone. A rule's weekdays and month
 * days are written in the organiser's zone, so they only carry over when the
 * two dates agree.
 *
 * @param {string | null} rule
 * @param {{day: string, sourceDay: string, until: (value: string) => string | null}} context
 * @returns {string | null}
 */
export function simpleRecurrenceRule(rule, { day, sourceDay, until }) {
  const parts = new Map();
  for (const part of String(rule ?? '').split(';')) {
    const [key, value] = part.split('=');
    if (!key || value === undefined || parts.has(key.toUpperCase())) return null;
    parts.set(key.toUpperCase(), value.toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (!SIMPLE_FREQUENCIES.has(freq) || (parts.get('INTERVAL') ?? '1') !== '1') return null;
  for (const key of parts.keys()) {
    if (!['FREQ', 'INTERVAL', 'WKST', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH'].includes(key)) {
      return null;
    }
  }
  const sameDay = day === sourceDay;
  const [, sourceMonth, sourceDate] = sourceDay.split('-').map(Number);

  let byday = '';
  if (parts.has('BYDAY')) {
    const days = parts.get('BYDAY').split(',');
    if (freq !== 'WEEKLY' || !sameDay || days.some((code) => !WEEKDAY_CODES.includes(code))) {
      return null;
    }
    byday = `;BYDAY=${WEEKDAY_CODES.filter((code) => days.includes(code)).join(',')}`;
  }
  if (parts.has('BYMONTHDAY')) {
    const monthly = freq === 'MONTHLY' || freq === 'YEARLY';
    if (!monthly || !sameDay || Number(parts.get('BYMONTHDAY')) !== sourceDate) return null;
  }
  if (parts.has('BYMONTH')) {
    if (freq !== 'YEARLY' || !sameDay || Number(parts.get('BYMONTH')) !== sourceMonth) return null;
  }

  let last = '';
  if (parts.has('UNTIL')) {
    const lastDay = until(parts.get('UNTIL'));
    if (!lastDay) return null;
    last = `;UNTIL=${lastDay}`;
  }
  return `${freq}${byday}${last}`;
}

/**
 * An RRULE's UNTIL (a UTC date-time, a floating date-time or a date) as the
 * last day of the series where the event is shown.
 * @param {string} value
 * @param {string | null} timeZone Null for an all-day series, whose days are
 *   the same everywhere.
 */
function untilDay(value, timeZone) {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  if (!timeZone || hour === undefined || !utc) return `${year}-${month}-${day}`;
  const instant = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  return Number.isFinite(instant.getTime()) ? wallClock(instant, timeZone).date : null;
}

/**
 * The calendar_events rows an invitation stands for, in the time zone it is
 * shown in. `recurrence` is 'series' when the organiser's rule carried over,
 * 'first' when the event repeats but only its first occurrence can be stored,
 * and 'none' otherwise.
 *
 * @param {any} invitation A calendar_invitations row.
 * @param {string} timeZone
 * @returns {{rows: {date: string, start: string, duration: number, all_day: boolean, recurrence_rule: string | null}[], recurrence: 'none' | 'series' | 'first'}}
 */
export function invitationEventRows(invitation, timeZone) {
  const start = new Date(invitation.start_at);
  const end = new Date(invitation.end_at);
  // One occurrence of a series is an event of its own; its rule is the series'.
  const repeats = Boolean(invitation.recurrence_rule) && !invitation.recurrence_id;

  if (invitation.all_day) {
    // All-day bounds are stored as UTC midnights; the end is exclusive.
    const days = Math.min(
      Math.max(Math.round((end.getTime() - start.getTime()) / MS_PER_DAY), 1),
      MAX_ALL_DAY_ROWS,
    );
    const day = utcDateKey(start);
    const rule =
      repeats && days === 1
        ? simpleRecurrenceRule(invitation.recurrence_rule, {
            day,
            sourceDay: day,
            until: (value) => untilDay(value, null),
          })
        : null;
    const rows = Array.from({ length: days }, (_, index) => ({
      date: utcDateKey(new Date(start.getTime() + index * MS_PER_DAY)),
      start: '00:00',
      duration: 24 * 60,
      all_day: true,
      recurrence_rule: rule,
    }));
    return { rows, recurrence: rule ? 'series' : repeats ? 'first' : 'none' };
  }

  const local = wallClock(start, timeZone);
  const sourceZone = validInvitationTimeZone(invitation.time_zone) ?? timeZone;
  const rule = repeats
    ? simpleRecurrenceRule(invitation.recurrence_rule, {
        day: local.date,
        sourceDay: wallClock(start, sourceZone).date,
        until: (value) => untilDay(value, timeZone),
      })
    : null;
  const minutes = Math.round((end.getTime() - start.getTime()) / MS_PER_MINUTE);
  return {
    rows: [
      {
        date: local.date,
        start: local.time,
        duration: Math.min(Math.max(minutes, 1), MAX_DURATION_MINUTES),
        all_day: false,
        recurrence_rule: rule,
      },
    ],
    recurrence: rule ? 'series' : repeats ? 'first' : 'none',
  };
}

/**
 * Makes the calendar hold exactly this invitation's entries, replacing any it
 * already holds. Runs inside the caller's transaction, which has locked the
 * invitation row, so two syncs of one invitation cannot interleave.
 *
 * The entries keep the calendar they are already filed under; new ones go to
 * the person's default calendar when it is one of Cookie's own, else to their
 * oldest writable calendar. One occurrence of a series is left alone while the
 * series itself is on the calendar: calendar_events cannot move a single
 * occurrence, so adding it would show that day twice.
 *
 * @param {any} tx
 * @param {any} invitation A calendar_invitations row.
 * @param {{timeZone: string, tone: string, onlyIfPresent?: boolean}} options
 *   `onlyIfPresent` updates entries that exist and adds none.
 * @returns {Promise<{event: {id: string, date: string} | null, recurrence: 'none' | 'series' | 'first'}>}
 */
export async function replaceInvitationEvents(tx, invitation, { timeZone, tone, onlyIfPresent }) {
  const { rows, recurrence } = invitationEventRows(invitation, timeZone);
  const [target] = await tx`
    SELECT
      COALESCE(
        (SELECT ce.calendar FROM calendar_events ce
         WHERE ce.invitation_id = ${invitation.id} AND ce.user_id = ${invitation.user_id}
         LIMIT 1),
        (SELECT c.id FROM calendars c
         WHERE c.user_id = ${invitation.user_id} AND c.subscription_url IS NULL
         ORDER BY (c.id::text = (SELECT u.prefs ->> 'defaultCalendarId' FROM users u
                                 WHERE u.id = ${invitation.user_id})) DESC NULLS LAST,
                  c.created_at, c.id
         LIMIT 1)
      ) AS calendar,
      EXISTS (SELECT 1 FROM calendar_events ce
              WHERE ce.invitation_id = ${invitation.id}
                AND ce.user_id = ${invitation.user_id}) AS on_calendar,
      EXISTS (SELECT 1 FROM calendar_events ce
              JOIN calendar_invitations series ON series.id = ce.invitation_id
              WHERE series.user_id = ${invitation.user_id} AND series.uid = ${invitation.uid}
                AND series.recurrence_id = '' AND series.id <> ${invitation.id}) AS series_on_calendar
  `;
  if (
    !target?.calendar ||
    (onlyIfPresent && !target.on_calendar) ||
    (invitation.recurrence_id && target.series_on_calendar && !target.on_calendar)
  ) {
    return { event: null, recurrence };
  }
  await tx`
    DELETE FROM calendar_events
    WHERE invitation_id = ${invitation.id} AND user_id = ${invitation.user_id}
  `;
  // The array itself, not a JSON string: postgres.js serialises a ::json
  // parameter, and a pre-stringified value would arrive as a JSON scalar.
  const inserted = await tx`
    INSERT INTO calendar_events
      (user_id, title, description, location, event_date, start_time, duration_minutes,
       calendar, tone, recurrence_rule, all_day, invitation_id)
    SELECT ${invitation.user_id}, ${invitation.title}, ${invitation.description},
           ${invitation.location}, entry.date, entry.start, entry.duration, ${target.calendar},
           ${tone}, entry.recurrence_rule, entry.all_day, ${invitation.id}
    FROM json_to_recordset(${rows}::json)
      AS entry(date text, start text, duration int, all_day boolean, recurrence_rule text)
    ORDER BY entry.date
    RETURNING id, event_date AS date
  `;
  return { event: inserted[0] ?? null, recurrence };
}

/**
 * @param {any} tx
 * @param {any} invitation A calendar_invitations row.
 */
export async function deleteInvitationEvents(tx, invitation) {
  await tx`
    DELETE FROM calendar_events
    WHERE invitation_id = ${invitation.id} AND user_id = ${invitation.user_id}
  `;
}

/**
 * Why Cookie will not answer an invitation, or null when it can.
 *
 * - 'cancelled': the organiser withdrew the event.
 * - 'not_configured': this deployment has no sending address.
 * - 'alias': the invitation names another of the person's addresses. Cookie
 *   sends as one address only, and answering for a different guest from it
 *   would put a reply the guest's address never sent in front of the organiser.
 * - 'not_invited': none of the guests is one of the person's addresses.
 *
 * @param {any} invitation A calendar_invitations row.
 * @param {string | null} sender
 * @returns {'cancelled' | 'not_configured' | 'alias' | 'not_invited' | null}
 */
export function invitationReplyBlock(invitation, sender) {
  if (invitation.status !== 'active') return 'cancelled';
  if (!sender) return 'not_configured';
  const attendee = normaliseAddress(invitation.attendee_address);
  if (!attendee) return 'not_invited';
  return attendee === sender ? null : 'alias';
}
