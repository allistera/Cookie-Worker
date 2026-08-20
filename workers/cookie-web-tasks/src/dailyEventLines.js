// Ported verbatim from Cookie-Web's src/lib/dailyEventLines.js — pure JS, no
// Node APIs.
//
// "Does this line describe a scheduled time" — operates on already-plain
// text: the caller strips Editor.js's inline HTML before calling this.
//
// Two shapes match, checked in this order so "10:00 - 11:00 - Title" isn't
// swallowed by the single-time pattern (its greedy title group would
// otherwise eat "11:00 - Title" whole):
//   "10:00 - 11:00 - Title"  -> explicit start and end
//   "10:00 - Title"          -> start only, defaults to a 30-minute event
const RANGE_RE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*-\s*(.*?)\s*$/;
const SINGLE_RE = /^(\d{1,2}):(\d{2})\s*-\s*(.*?)\s*$/;
const DEFAULT_DURATION_MINUTES = 30;
const MAX_TITLE = 200;

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');

/** @param {number} hour @param {number} minute */
function validTime(hour, minute) {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/**
 * @param {any} text - already-plain text (no HTML); may be anything callers
 *   pass through unchecked, hence `any` rather than `string`
 * @returns {{start: string, durationMinutes: number, title: string} | null}
 */
export function matchTimeLine(text) {
  const line = String(text ?? '').trim();

  const range = RANGE_RE.exec(line);
  if (range) {
    const [, sh, sm, eh, em, rawTitle] = range;
    const startHour = Number(sh);
    const startMinute = Number(sm);
    const endHour = Number(eh);
    const endMinute = Number(em);
    const title = rawTitle.trim().slice(0, MAX_TITLE);
    if (!validTime(startHour, startMinute) || !validTime(endHour, endMinute) || !title) return null;
    const durationMinutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
    if (durationMinutes <= 0) return null;
    return { start: `${pad2(startHour)}:${pad2(startMinute)}`, durationMinutes, title };
  }

  const single = SINGLE_RE.exec(line);
  if (single) {
    const [, sh, sm, rawTitle] = single;
    const startHour = Number(sh);
    const startMinute = Number(sm);
    const title = rawTitle.trim().slice(0, MAX_TITLE);
    if (!validTime(startHour, startMinute) || !title) return null;
    return {
      start: `${pad2(startHour)}:${pad2(startMinute)}`,
      durationMinutes: DEFAULT_DURATION_MINUTES,
      title,
    };
  }

  return null;
}
