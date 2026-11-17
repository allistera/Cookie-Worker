import ical from 'node-ical';

import { isValidEmailAddress } from '../../../shared/email-validation.js';

export const MAX_CALENDAR_ATTACHMENT_BYTES = 256 * 1024;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;
const MAX_LOCATION = 200;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   title: string,
 *   description: string | null,
 *   location: string | null,
 *   start_at: string,
 *   end_at: string,
 * }} CalendarInvite
 */

/**
 * What an iTIP message says about one event: enough to recognise a later
 * revision or cancellation of it and to answer its organiser.
 *
 * `recurrenceId` is '' for an event, or for a whole series, and otherwise the
 * original start of the one occurrence the message is about, as a UTC
 * `YYYYMMDDTHHMMSSZ` (or `YYYYMMDD` for an all-day occurrence).
 *
 * @typedef {{
 *   method: 'request' | 'cancel',
 *   uid: string,
 *   recurrenceId: string,
 *   sequence: number,
 *   dtstamp: string | null,
 *   organizer: {address: string, name: string | null},
 *   attendees: {address: string, name: string | null}[],
 *   title: string,
 *   description: string | null,
 *   location: string | null,
 *   startAt: string,
 *   endAt: string,
 *   allDay: boolean,
 *   recurrenceRule: string | null,
 *   timeZone: string | null,
 * }} ParsedInvitation
 */

/**
 * @typedef {{
 *   filename?: string | null,
 *   content_type?: string | null,
 *   size_bytes?: number | string | null,
 *   downloadable?: boolean,
 *   blob_url?: string | null,
 * }} CalendarAttachment
 */

/**
 * @typedef {{
 *   stream: ReadableStream<Uint8Array> | null,
 * }} BlobReadResult
 */

/**
 * @param {unknown} value
 * @returns {Date | null}
 */
function validDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return value;
}

/**
 * node-ical returns a property that carries parameters, such as
 * `SUMMARY;LANGUAGE=en-GB:Team sync` from Outlook and Google invites, as
 * `{ params, val }` rather than a string. Stringifying that object would show
 * the reader "[object Object]", so unwrap it first.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function propertyValue(value) {
  if (value && typeof value === 'object' && 'val' in value) return value.val;
  return value;
}

/**
 * @param {unknown} value
 * @param {number} limit
 * @returns {string | null}
 */
function boundedText(value, limit) {
  const raw = propertyValue(value);
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return text ? text.slice(0, limit) : null;
}

/**
 * PostgreSQL can expose BIGINT columns as decimal strings. Only accept a
 * canonical, safe, non-negative integer representation before applying the
 * attachment byte limit.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizeAttachmentSize(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

/**
 * node-ical supplies an implicit `end` equal to `start` when an event has no
 * DTEND. Keep the source-level presence bit so an explicit zero-length or
 * malformed DTEND is not mistaken for that implicit value.
 *
 * @param {string} ics
 * @returns {{byUid: Map<string, boolean>, ordered: boolean[]}}
 */
function explicitEndInfo(ics) {
  const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const byUid = new Map();
  const ordered = [];
  let inEvent = false;
  /** @type {string | null} */
  let uid = null;
  let hasEnd = false;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      inEvent = true;
      uid = null;
      hasEnd = false;
    } else if (inEvent && upper === 'END:VEVENT') {
      ordered.push(hasEnd);
      if (uid) byUid.set(uid, hasEnd);
      inEvent = false;
    } else if (inEvent) {
      const uidMatch = /^UID:(.*)$/i.exec(line);
      if (uidMatch) uid = uidMatch[1];
      if (/^DTEND(?:;[^:]*)?:/i.test(line)) hasEnd = true;
    }
  }
  return { byUid, ordered };
}

/**
 * node-ical warns with portions of malformed, sender-controlled properties
 * (for example an unknown TZID). Parsing is best effort, so discard those
 * warnings rather than copying untrusted ICS details into Worker logs.
 *
 * @param {string} ics
 * @returns {any}
 */
function parseICSQuietly(ics) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return ical.parseICS(ics);
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * If one broken VEVENT makes node-ical reject the complete calendar, retry the
 * individual components so a valid event in the same attachment can survive.
 *
 * @param {string} ics
 * @returns {unknown[]}
 */
function parseCalendarValues(ics) {
  try {
    return Object.values(parseICSQuietly(ics));
  } catch {
    const lines = ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const values = [];
    let block = [];
    let inEvent = false;
    for (const line of lines) {
      if (line.toUpperCase() === 'BEGIN:VEVENT') {
        inEvent = true;
        block = [line];
      } else if (inEvent) {
        block.push(line);
        if (line.toUpperCase() === 'END:VEVENT') {
          try {
            values.push(
              ...Object.values(
                parseICSQuietly(`BEGIN:VCALENDAR\n${block.join('\n')}\nEND:VCALENDAR`),
              ),
            );
          } catch {
            // Ignore this malformed VEVENT and continue with the next one.
          }
          inEvent = false;
          block = [];
        }
      }
    }
    return values;
  }
}

/**
 * Read a Blob stream without ever buffering more than the calendar limit.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<string | null>}
 */
async function readCalendarStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      total += value.byteLength;
      if (total > MAX_CALENDAR_ATTACHMENT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The original read failure is intentionally not exposed.
    }
    return null;
  } finally {
    reader.releaseLock();
  }
}

/**
 * @param {string} ics
 * @returns {CalendarInvite | null}
 */
function parseCalendarText(ics) {
  /** @type {CalendarInvite | null} */
  let earliest = null;
  let earliestStart = Infinity;
  const endInfo = explicitEndInfo(ics);
  let eventIndex = 0;
  for (const value of parseCalendarValues(ics)) {
    const event = /** @type {any} */ (value);
    if (!event || typeof event !== 'object' || event.type !== 'VEVENT') continue;
    const currentEventIndex = eventIndex;
    eventIndex += 1;
    if (String(event.status ?? '').toUpperCase() === 'CANCELLED') continue;
    // VALUE=DATE is an all-day event and is not a timed calendar invite.
    if (event.datetype === 'date') continue;

    const start = validDate(event.start);
    if (!start) continue;

    const hasExplicitEnd = endInfo.byUid.has(event.uid)
      ? endInfo.byUid.get(event.uid)
      : endInfo.ordered[currentEventIndex];
    let end;
    if (hasExplicitEnd) {
      end = validDate(event.end);
      if (!end) continue;
    } else {
      end = new Date(start.getTime() + DEFAULT_DURATION_MS);
    }
    if (end.getTime() <= start.getTime()) continue;

    const startTime = start.getTime();
    if (startTime >= earliestStart) continue;
    earliestStart = startTime;
    earliest = {
      title: boundedText(event.summary, MAX_TITLE) || 'Untitled event',
      description: boundedText(event.description, MAX_DESCRIPTION),
      location: boundedText(event.location, MAX_LOCATION),
      start_at: start.toISOString(),
      end_at: end.toISOString(),
    };
  }
  return earliest;
}

const MAX_UID = 500;
const MAX_NAME = 200;
const MAX_RRULE = 500;
const MAX_ATTENDEES = 500;

/**
 * The bare, lower-cased address of an ORGANIZER or ATTENDEE value
 * (`mailto:someone@example.com`), or null when it is not one mail address.
 * @param {unknown} value
 */
function calendarAddress(value) {
  const text = String(propertyValue(value) ?? '').trim();
  const address = text.replace(/^mailto:/i, '').toLowerCase();
  return isValidEmailAddress(address) ? address : null;
}

/**
 * @param {unknown} value An ORGANIZER or ATTENDEE as node-ical returns it.
 * @returns {{address: string, name: string | null} | null}
 */
function calendarParticipant(value) {
  const address = calendarAddress(value);
  if (!address) return null;
  const params = /** @type {any} */ (value)?.params;
  const name = boundedText(params?.CN, MAX_NAME);
  // Google writes the address itself as CN when the guest has no name.
  return { address, name: name && name.toLowerCase() !== address ? name : null };
}

/** @param {number} value */
const pad2 = (value) => String(value).padStart(2, '0');

/**
 * node-ical builds a VALUE=DATE value from the date's components in the
 * runtime's own zone, so the day is read back the same way.
 * @param {Date} date
 */
const localDay = (date) =>
  `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;

/** @param {Date} date */
const utcBasic = (date) =>
  `${date.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`;

/** @param {string} day A `YYYYMMDD` day. */
const utcMidnight = (day) =>
  new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6))));

/**
 * @param {any} event
 * @returns {string | null}
 */
function recurrenceRuleText(event) {
  if (!event.rrule || !(event.rrule.toString instanceof Function)) return null;
  const line = String(event.rrule.toString())
    .split(/\r?\n/)
    .find((entry) => /^RRULE:/i.test(entry));
  const rule = line ? line.slice('RRULE:'.length).trim() : '';
  return rule && rule.length <= MAX_RRULE ? rule : null;
}

/**
 * The event an iTIP REQUEST or CANCEL is about. Other methods (a guest's
 * REPLY, a COUNTER) and plain calendar files with no METHOD are not
 * invitations to this mailbox and return null.
 *
 * A message about a series can carry the series and changed occurrences of it
 * together; the series is the one tracked, since it is what the guest answers.
 *
 * @param {string} ics
 * @returns {ParsedInvitation | null}
 */
export function parseCalendarInvitation(ics) {
  /** @type {any} */
  let chosen = null;
  for (const value of parseCalendarValues(ics)) {
    const event = /** @type {any} */ (value);
    if (!event || typeof event !== 'object' || event.type !== 'VEVENT') continue;
    if (!chosen || (chosen.recurrenceid && !event.recurrenceid)) chosen = event;
    if (!chosen.recurrenceid) break;
  }
  if (!chosen) return null;

  const method = String(chosen.method ?? '').toUpperCase();
  if (method !== 'REQUEST' && method !== 'CANCEL') return null;
  const uid = String(propertyValue(chosen.uid) ?? '').trim();
  const organizer = calendarParticipant(chosen.organizer);
  const start = validDate(chosen.start);
  if (!uid || uid.length > MAX_UID || !organizer || !start) return null;

  const allDay = chosen.datetype === 'date';
  const parsedEnd = validDate(chosen.end);
  let startAt = start;
  let endAt;
  if (allDay) {
    startAt = utcMidnight(localDay(start));
    endAt = parsedEnd ? utcMidnight(localDay(parsedEnd)) : startAt;
    if (endAt.getTime() <= startAt.getTime()) endAt = new Date(startAt.getTime() + DAY_MS);
  } else {
    endAt =
      parsedEnd && parsedEnd.getTime() > start.getTime()
        ? parsedEnd
        : new Date(start.getTime() + DEFAULT_DURATION_MS);
  }

  const recurrence = validDate(chosen.recurrenceid);
  const sequence = Number(chosen.sequence);
  const attendees = (Array.isArray(chosen.attendee) ? chosen.attendee : [chosen.attendee])
    .slice(0, MAX_ATTENDEES)
    .map(calendarParticipant)
    .filter((participant) => participant !== null);
  const zone = String(/** @type {any} */ (chosen.start).tz ?? '');

  return {
    // A CANCEL names the event it withdraws; STATUS:CANCELLED on a REQUEST
    // says the same thing about the event it carries.
    method:
      method === 'CANCEL' || String(chosen.status ?? '').toUpperCase() === 'CANCELLED'
        ? 'cancel'
        : 'request',
    uid,
    recurrenceId: recurrence ? (allDay ? localDay(recurrence) : utcBasic(recurrence)) : '',
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
    dtstamp: validDate(chosen.dtstamp)?.toISOString() ?? null,
    organizer,
    attendees,
    title: boundedText(chosen.summary, MAX_TITLE) || 'Untitled event',
    description: boundedText(chosen.description, MAX_DESCRIPTION),
    location: boundedText(chosen.location, MAX_LOCATION),
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    allDay,
    recurrenceRule: recurrenceRuleText(chosen),
    timeZone: zone && zone.length <= 100 ? zone : null,
  };
}

/** @param {CalendarAttachment} attachment */
export function isCalendarAttachment(attachment) {
  const filename = String(attachment?.filename ?? '').toLowerCase();
  const contentType = String(attachment?.content_type ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  const size = normalizeAttachmentSize(attachment?.size_bytes);
  return (
    (contentType === 'text/calendar' || filename.endsWith('.ics')) &&
    attachment?.downloadable === true &&
    Boolean(attachment?.blob_url) &&
    size !== null &&
    size <= MAX_CALENDAR_ATTACHMENT_BYTES
  );
}

/**
 * Reads a message's calendar attachments once and returns both views of
 * them: `invite`, the earliest upcoming timed event (what "Add to calendar"
 * offers), and `invitation`, the first attachment's iTIP invitation, if any.
 *
 * @param {CalendarAttachment[]} attachments
 * @param {(url: string) => Promise<BlobReadResult | null>} [readBlob]
 * @returns {Promise<{invite: CalendarInvite | null, invitation: ParsedInvitation | null}>}
 */
export async function extractCalendarDetails(attachments, readBlob) {
  /** @type {CalendarInvite | null} */
  let earliest = null;
  /** @type {ParsedInvitation | null} */
  let invitation = null;
  if (typeof readBlob !== 'function') return { invite: earliest, invitation };

  let earliestStart = Infinity;
  for (const attachment of attachments ?? []) {
    if (!isCalendarAttachment(attachment)) continue;

    try {
      const blob = await readBlob(/** @type {string} */ (attachment.blob_url));
      if (!blob?.stream) continue;
      const text = await readCalendarStream(blob.stream);
      if (text === null) continue;
      invitation ??= parseCalendarInvitation(text);
      const candidate = parseCalendarText(text);
      if (!candidate) continue;
      const startTime = Date.parse(candidate.start_at);
      if (startTime < earliestStart) {
        earliestStart = startTime;
        earliest = candidate;
      }
    } catch {
      // Attachment parsing is best effort; opening a message must still work.
    }
  }
  return { invite: earliest, invitation };
}

/**
 * @param {CalendarAttachment[]} attachments
 * @param {(url: string) => Promise<BlobReadResult | null>} [readBlob]
 * @returns {Promise<CalendarInvite | null>}
 */
export async function extractCalendarInvite(attachments, readBlob) {
  return (await extractCalendarDetails(attachments, readBlob)).invite;
}
