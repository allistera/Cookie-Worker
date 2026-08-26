// Ported from Cookie-Web's api/calendar-events.js — the recurrence-expansion
// half, unchanged. Cookie-Web keeps its own copy in api/_lib/recurrence.js
// for the vite dev/e2e calendar fixture — kept in sync by hand.

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const EXPAND_PAST_DAYS = 365;
export const EXPAND_FUTURE_DAYS = 730;
const MAX_OCCURRENCES_PER_SERIES = 366;
// Global ceiling on occurrences emitted in one response across all series.
// MAX_OCCURRENCES_PER_SERIES bounds each series individually; without a total
// cap, N daily series serialize up to 366·N event objects on every load.
const MAX_TOTAL_OCCURRENCES = 5000;
// Occurrences before the window are stepped over without being emitted, so the
// occurrence cap alone does not bound the work: a DAILY series dated 0001-01-01
// (which both DATE_RE and migration 0022's CHECK accept) would step ~740k times
// on every calendar load. Cap total steps too — 10k covers a daily series
// starting ~27 years back, weekly ~190 years, monthly ~830 years. A WEEKLY
// series with BYDAY steps day-by-day (see expandEvent), so it shares DAILY's
// ~27-year reach rather than WEEKLY's.
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

// Clamps day-of-month so e.g. "31st of every month" lands on the last day of
// short months instead of overflowing into the next one.
/**
 * @param {Date} date
 * @param {string} freq
 */
function stepDate(date, freq) {
  const next = new Date(date);
  if (freq === 'DAILY') {
    next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  if (freq === 'WEEKLY') {
    next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }
  const day = next.getUTCDate();
  const month = freq === 'YEARLY' ? next.getUTCMonth() : next.getUTCMonth() + 1;
  const yearsAhead = freq === 'YEARLY' ? 1 : 0;
  next.setUTCDate(1);
  next.setUTCFullYear(next.getUTCFullYear() + yearsAhead);
  next.setUTCMonth(month);
  const daysInTargetMonth = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(day, daysInTargetMonth));
  return next;
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

// Skip occurrence generation that would land before windowStart so an ancient
// DAILY series does not burn MAX_STEPS_PER_SERIES just walking to the window.
// The MONTHLY/YEARLY branches iterate stepDate too, so they share the same
// step budget — otherwise a series dated 0001-01-01 would loop ~24k (monthly)
// or ~2k (yearly) times per request, defeating the DAILY/WEEKLY bound.
/**
 * @param {Date} cursor
 * @param {Date} windowStart
 * @param {string} freq
 * @param {{remaining: number}} budget
 */
function jumpToWindow(cursor, windowStart, freq, budget) {
  if (cursor >= windowStart) return cursor;
  if (freq === 'DAILY') {
    const next = new Date(cursor);
    next.setUTCDate(next.getUTCDate() + daysBetweenUtc(cursor, windowStart));
    return next;
  }
  if (freq === 'WEEKLY') {
    const weeks = Math.floor(daysBetweenUtc(cursor, windowStart) / 7);
    const next = new Date(cursor);
    next.setUTCDate(next.getUTCDate() + weeks * 7);
    return next;
  }
  if (freq === 'YEARLY') {
    let next = cursor;
    const years = Math.min(
      Math.max(0, windowStart.getUTCFullYear() - cursor.getUTCFullYear()),
      MAX_STEPS_PER_SERIES,
      budget.remaining,
    );
    for (let i = 0; i < years; i += 1) next = stepDate(next, 'YEARLY');
    budget.remaining -= years;
    return next;
  }
  if (freq === 'MONTHLY') {
    const months =
      (windowStart.getUTCFullYear() - cursor.getUTCFullYear()) * 12 +
      (windowStart.getUTCMonth() - cursor.getUTCMonth());
    let next = cursor;
    const jumps = Math.min(Math.max(0, months - 1), MAX_STEPS_PER_SERIES, budget.remaining);
    for (let i = 0; i < jumps; i += 1) next = stepDate(next, 'MONTHLY');
    budget.remaining -= jumps;
    let guard = 0;
    while (next < windowStart && guard < MAX_STEPS_PER_SERIES && budget.remaining > 0) {
      next = stepDate(next, 'MONTHLY');
      guard += 1;
      budget.remaining -= 1;
    }
    return next;
  }
  return cursor;
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
  // A series that ended before the window can't emit anything — return
  // before jumpToWindow, whose MONTHLY/YEARLY paths step iteratively, so an
  // expired series costs nothing instead of up to MAX_STEPS_PER_SERIES.
  if (until && until < windowStart) return [];
  // BYDAY (e.g. "Monday to Friday") only makes sense for WEEKLY, and needs
  // day-by-day stepping to land on each selected weekday rather than jumping
  // 7 days from the series' own start-date weekday.
  const weekdays = rule.byday
    ? new Set(rule.byday.map((code) => WEEKDAY_CODES.indexOf(code)))
    : null;
  const stepFreq = weekdays ? 'DAILY' : rule.freq;
  const occurrences = [];
  let cursor = jumpToWindow(dtstart, windowStart, stepFreq, budget);
  let index = 0;
  while (
    cursor <= windowEnd &&
    (!until || cursor <= until) &&
    occurrences.length < MAX_OCCURRENCES_PER_SERIES &&
    index < MAX_STEPS_PER_SERIES &&
    budget.remaining > 0
  ) {
    if (cursor >= windowStart && (!weekdays || weekdays.has(cursor.getUTCDay()))) {
      occurrences.push({
        ...event,
        id: `${event.id}:${index}`,
        seriesId: event.id,
        seriesDate: event.date,
        date: toDateKey(cursor),
      });
    }
    cursor = stepDate(cursor, stepFreq);
    index += 1;
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
