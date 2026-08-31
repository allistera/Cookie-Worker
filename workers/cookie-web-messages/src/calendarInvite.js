import ical from 'node-ical';

export const MAX_CALENDAR_ATTACHMENT_BYTES = 256 * 1024;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 2000;
const MAX_LOCATION = 200;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

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
 * @param {unknown} value
 * @param {number} limit
 * @returns {string | null}
 */
function boundedText(value, limit) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
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

/**
 * @param {CalendarAttachment[]} attachments
 * @param {(url: string) => Promise<BlobReadResult | null>} [readBlob]
 * @returns {Promise<CalendarInvite | null>}
 */
export async function extractCalendarInvite(attachments, readBlob) {
  if (typeof readBlob !== 'function') return null;

  /** @type {CalendarInvite | null} */
  let earliest = null;
  let earliestStart = Infinity;
  for (const attachment of attachments ?? []) {
    const filename = String(attachment?.filename ?? '').toLowerCase();
    const contentType = String(attachment?.content_type ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    const isCalendar = contentType === 'text/calendar' || filename.endsWith('.ics');
    const size = normalizeAttachmentSize(attachment?.size_bytes);
    if (
      !isCalendar ||
      attachment?.downloadable !== true ||
      !attachment?.blob_url ||
      size === null ||
      size > MAX_CALENDAR_ATTACHMENT_BYTES
    ) {
      continue;
    }

    try {
      const blob = await readBlob(attachment.blob_url);
      if (!blob?.stream) continue;
      const text = await readCalendarStream(blob.stream);
      if (text === null) continue;
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
  return earliest;
}
