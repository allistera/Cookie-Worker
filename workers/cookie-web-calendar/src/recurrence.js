// Ported from Cookie-Web's api/calendar-events.js — the recurrence-expansion
// half. Cookie-Web keeps its own copy in scripts/localApi/recurrence.js for the vite
// dev/e2e calendar fixture — kept in sync by hand (date-keyed occurrence ids
// and start-relative MONTHLY/YEARLY expansion landed here first).

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const EXPAND_PAST_DAYS = 365;
export const EXPAND_FUTURE_DAYS = 730;
const MAX_OCCURRENCES_PER_SERIES = 366;
// Global ceiling on occurrences emitted in one response across all series.
// MAX_OCCURRENCES_PER_SERIES bounds each series individually; without a total
// cap, N daily series serialize up to 366·N event objects on every load.
const MAX_TOTAL_OCCURRENCES = 5000;
// Expansion jumps straight to the window (firstIndexNearWindow), but the
// occurrence cap alone still does not bound the loop: a WEEKLY BYDAY series
// steps day-by-day and skips unselected weekdays without emitting. Cap the
// steps each series may take inside the window too.
const MAX_STEPS_PER_SERIES = 10_000;
// One aggregate stepping budget across the whole response. Per-series caps
// bound each series, but N pathological series each stepping up to
// MAX_STEPS_PER_SERIES — including expired or otherwise zero-output ones —
// still multiply into real CPU on every calendar load. 100k steps is far
// beyond what any window of legitimate series needs to emit the 5,000
// occurrence ceiling.
const MAX_TOTAL_STEPS = 100_000;
// Explicit ranges may span at least the default window so the two contracts
// cannot drift apart again (the default window used to exceed this cap).
const MAX_RANGE_DAYS = EXPAND_PAST_DAYS + EXPAND_FUTURE_DAYS;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// RFC5545-style two-letter weekday codes, in week order (index doubles as the
// Date#getUTCDay() value for that weekday).
export const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_RE = '(?:SU|MO|TU|WE|TH|FR|SA)';
const RECURRENCE_RE = new RegExp(
  `^(DAILY|WEEKLY|MONTHLY|YEARLY)(?:;BYDAY=(${WEEKDAY_RE}(?:,${WEEKDAY_RE}){0,6}))?(?:;UNTIL=(\\d{4}-\\d{2}-\\d{2}))?$`,
);

// The UI only offers a fixed set of frequencies with an optional end date and,
// for weekly series, an optional set of specific weekdays — so the stored
// rule is a small custom format rather than full RFC5545 — see migrations
// 0025 and 0031.
/**
 * @param {string} repeat
 * @param {string | null} repeatUntil
 * @param {string[] | null} repeatDays
 */
export function buildRecurrenceRule(repeat, repeatUntil, repeatDays) {
  if (repeat === 'none') return null;
  const freq = repeat.toUpperCase();
  const byday = repeat === 'weekly' && repeatDays?.length ? `;BYDAY=${repeatDays.join(',')}` : '';
  return repeatUntil ? `${freq}${byday};UNTIL=${repeatUntil}` : `${freq}${byday}`;
}

/** @param {unknown} rule */
function parseRecurrenceRule(rule) {
  const match = String(rule ?? '').match(RECURRENCE_RE);
  if (!match) return null;
  return { freq: match[1], byday: match[2] ? match[2].split(',') : null, until: match[3] ?? null };
}

// The n-th occurrence (0 = the series start) is computed from the series
// start rather than stepped from the previous occurrence, so a clamped short
// month does not drag every later occurrence with it: "31st of every month"
// lands on Feb 28/29, then back on Mar 31; a Feb 29 yearly series lands on
// Feb 28 in common years and Feb 29 again in leap years.
/**
 * @param {Date} dtstart
 * @param {string} freq
 * @param {number} n
 */
function occurrenceAt(dtstart, freq, n) {
  const next = new Date(dtstart);
  if (freq === 'DAILY') {
    next.setUTCDate(next.getUTCDate() + n);
    return next;
  }
  if (freq === 'WEEKLY') {
    next.setUTCDate(next.getUTCDate() + n * 7);
    return next;
  }
  const monthIndex =
    dtstart.getUTCFullYear() * 12 + dtstart.getUTCMonth() + (freq === 'YEARLY' ? n * 12 : n);
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex % 12;
  next.setUTCFullYear(year, month, Math.min(dtstart.getUTCDate(), daysInMonthUtc(year, month)));
  return next;
}

/**
 * @param {number} year
 * @param {number} month 0-based
 */
function daysInMonthUtc(year, month) {
  // setUTCFullYear, unlike Date.UTC, does not remap years 0-99 to 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month + 1, 0);
  return date.getUTCDate();
}

/** @param {Date} date */
const toDateKey = (date) => date.toISOString().slice(0, 10);

/**
 * @param {Date} from
 * @param {Date} to
 */
function daysBetweenUtc(from, to) {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

// Index of an occurrence at or shortly before windowStart, computed in O(1)
// so an ancient series does not spend its step budget walking to the window.
// It never overshoots: the expansion loop skips any leftover occurrences that
// still fall before the window.
/**
 * @param {Date} dtstart
 * @param {Date} windowStart
 * @param {string} freq
 */
function firstIndexNearWindow(dtstart, windowStart, freq) {
  if (dtstart >= windowStart) return 0;
  const elapsedMs = windowStart.getTime() - dtstart.getTime();
  if (freq === 'DAILY') return Math.floor(elapsedMs / MS_PER_DAY);
  if (freq === 'WEEKLY') return Math.floor(elapsedMs / (7 * MS_PER_DAY));
  const months =
    (windowStart.getUTCFullYear() - dtstart.getUTCFullYear()) * 12 +
    (windowStart.getUTCMonth() - dtstart.getUTCMonth());
  if (freq === 'YEARLY') return Math.max(0, Math.floor(months / 12) - 1);
  return Math.max(0, months - 1);
}

// Expands one series-master row into its occurrences within [windowStart,
// windowEnd]. Non-recurring events pass through unchanged. There's no
// support for per-occurrence exceptions: editing or deleting any occurrence
// acts on the whole series.
/**
 * @param {any} event
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @param {{remaining: number}} [budget]
 */
function expandEvent(event, windowStart, windowEnd, budget = { remaining: MAX_TOTAL_STEPS }) {
  const rule = parseRecurrenceRule(event.recurrenceRule);
  if (!rule) return [{ ...event, seriesId: event.id }];

  const dtstart = new Date(`${event.date}T${event.start}:00Z`);
  const until = rule.until ? new Date(`${rule.until}T23:59:59Z`) : null;
  // A series that ended before the window can't emit anything.
  if (until && until < windowStart) return [];
  // BYDAY (e.g. "Monday to Friday") only makes sense for WEEKLY, and needs
  // day-by-day stepping to land on each selected weekday rather than jumping
  // 7 days from the series' own start-date weekday.
  const weekdays = rule.byday
    ? new Set(rule.byday.map((code) => WEEKDAY_CODES.indexOf(code)))
    : null;
  const stepFreq = weekdays ? 'DAILY' : rule.freq;
  const occurrences = [];
  let n = firstIndexNearWindow(dtstart, windowStart, stepFreq);
  let cursor = occurrenceAt(dtstart, stepFreq, n);
  let steps = 0;
  while (
    cursor <= windowEnd &&
    (!until || cursor <= until) &&
    occurrences.length < MAX_OCCURRENCES_PER_SERIES &&
    steps < MAX_STEPS_PER_SERIES &&
    budget.remaining > 0
  ) {
    if (cursor >= windowStart && (!weekdays || weekdays.has(cursor.getUTCDay()))) {
      const date = toDateKey(cursor);
      occurrences.push({
        ...event,
        // Keyed by the occurrence's own date (at most one per day for every
        // supported frequency), so the same occurrence keeps the same id
        // whatever range the client asked for.
        id: `${event.id}:${date}`,
        seriesId: event.id,
        seriesDate: event.date,
        date,
      });
    }
    n += 1;
    cursor = occurrenceAt(dtstart, stepFreq, n);
    steps += 1;
    budget.remaining -= 1;
  }
  return occurrences;
}

// With a range, recurring series expand only into [from, to] instead of the
// default now-relative window — the SQL range filter keeps series masters
// unconditionally, so this clip is what actually bounds their payload.
// Non-recurring events still pass through untouched; the SQL filter already
// windowed them. A global occurrence cap bounds the whole response: once it
// is hit, remaining series are dropped and `truncated` reports it.
/**
 * @param {any[]} events
 * @param {Date} [now]
 * @param {{from: string, to: string} | null} [range]
 */
export function expandEventsPage(events, now = new Date(), range = null) {
  const windowStart = range
    ? new Date(`${range.from}T00:00:00Z`)
    : new Date(now.getTime() - EXPAND_PAST_DAYS * MS_PER_DAY);
  const windowEnd = range
    ? new Date(`${range.to}T23:59:59Z`)
    : new Date(now.getTime() + EXPAND_FUTURE_DAYS * MS_PER_DAY);
  const occurrences = [];
  let truncated = false;
  // Shared across every series in the response, so many zero-output series
  // can't each spend a full per-series step budget.
  const budget = { remaining: MAX_TOTAL_STEPS };
  for (const event of events) {
    const expanded = expandEvent(event, windowStart, windowEnd, budget);
    const remaining = MAX_TOTAL_OCCURRENCES - occurrences.length;
    if (expanded.length > remaining) {
      occurrences.push(...expanded.slice(0, Math.max(0, remaining)));
      truncated = true;
      break;
    }
    occurrences.push(...expanded);
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
  }
  return { events: occurrences, truncated };
}

/**
 * @param {any[]} events
 * @param {Date} [now]
 * @param {{from: string, to: string} | null} [range]
 */
export function expandEvents(events, now = new Date(), range = null) {
  return expandEventsPage(events, now, range).events;
}

// from/to are optional but must come as a valid pair: omitting both keeps the
// original return-everything contract, anything else is a client bug worth a
// 400 rather than a silently unbounded payload.
/** @param {Date} [now] */
function defaultEventRange(now = new Date()) {
  return {
    from: toDateKey(new Date(now.getTime() - EXPAND_PAST_DAYS * MS_PER_DAY)),
    to: toDateKey(new Date(now.getTime() + EXPAND_FUTURE_DAYS * MS_PER_DAY)),
  };
}

/**
 * @param {URLSearchParams} searchParams
 * @param {Date} [now]
 * @returns {{range: {from: string, to: string}, error?: undefined} | {error: true, range?: undefined}}
 */
export function parseRangeParams(searchParams, now = new Date()) {
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (from === null && to === null) return { range: defaultEventRange(now) };
  if (from === null || to === null || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    return { error: true };
  }
  const spanDays = daysBetweenUtc(new Date(`${from}T00:00:00Z`), new Date(`${to}T00:00:00Z`));
  if (spanDays > MAX_RANGE_DAYS) return { error: true };
  return { range: { from, to } };
}
