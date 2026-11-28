// When an automation runs. A trigger is stored as
// {type: 'schedule', time: 'HH:MM', days: [...], timeZone: '<IANA zone>'}:
// a wall-clock time on chosen days of the week, in the person's own zone, so
// "midnight" stays midnight across a clock change.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A trigger the API cannot accept; the message is shown to the person. */
export class TriggerError extends Error {}

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();

/** @param {string} timeZone */
function zoneFormat(timeZone) {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formats.set(timeZone, format);
  }
  return format;
}

/**
 * The wall clock in a zone at an instant.
 *
 * @param {string} timeZone
 * @param {Date | number} instant
 */
function wallClock(timeZone, instant) {
  /** @type {Record<string, number>} */
  const parts = {};
  for (const part of zoneFormat(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

/**
 * The calendar date in a zone at an instant, as YYYY-MM-DD.
 *
 * @param {string} timeZone
 * @param {Date} instant
 */
export function localDate(timeZone, instant) {
  const { year, month, day } = wallClock(timeZone, instant);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The instant a wall-clock time falls on in a zone. A time the clocks skip
 * (the hour lost in spring) lands on the instant the clocks jump to.
 *
 * @param {string} timeZone
 * @param {number} year @param {number} month @param {number} day
 * @param {number} hour @param {number} minute
 */
function instantOf(timeZone, year, month, day, hour, minute) {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  // The zone's offset at the first guess can differ from its offset at the
  // answer when a clock change lies between them; a second pass settles it.
  for (let pass = 0; pass < 2; pass += 1) {
    const shown = wallClock(timeZone, guess);
    guess += wanted - Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute);
  }
  return guess;
}

/**
 * Reads a trigger from a request body or a stored row, refusing anything
 * that is not a complete weekly schedule.
 *
 * @param {any} input
 * @returns {{type: 'schedule', time: string, days: string[], timeZone: string}}
 */
export function normalizeTrigger(input) {
  if (!input || typeof input !== 'object' || input.type !== 'schedule') {
    throw new TriggerError('trigger must be a schedule');
  }
  if (typeof input.time !== 'string' || !TIME.test(input.time)) {
    throw new TriggerError('trigger.time must be a 24-hour HH:MM time');
  }
  const days = Array.isArray(input.days) ? DAYS.filter((day) => input.days.includes(day)) : [];
  if (!days.length || days.length !== new Set(input.days).size) {
    throw new TriggerError(
      'trigger.days must list at least one of sun, mon, tue, wed, thu, fri, sat',
    );
  }
  const timeZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : '';
  try {
    if (!timeZone || timeZone.length > 100) throw new RangeError('timeZone');
    zoneFormat(timeZone);
  } catch {
    throw new TriggerError('trigger.timeZone must be an IANA time zone such as Europe/London');
  }
  return { type: 'schedule', time: input.time, days, timeZone };
}

/**
 * The first instant after `after` that the trigger falls on.
 *
 * @param {{time: string, days: string[], timeZone: string}} trigger A normalised trigger.
 * @param {Date} after
 * @returns {Date}
 */
export function nextRunAt(trigger, after) {
  const [hour, minute] = trigger.time.split(':').map(Number);
  const start = wallClock(trigger.timeZone, after);
  // Today and the seven days after it: a schedule with one day whose time
  // has already passed today next falls a week on.
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    if (!trigger.days.includes(DAYS[date.getUTCDay()])) continue;
    const instant = instantOf(
      trigger.timeZone,
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      hour,
      minute,
    );
    if (instant > after.getTime()) return new Date(instant);
  }
  throw new RangeError('The trigger has no day to run on');
}
