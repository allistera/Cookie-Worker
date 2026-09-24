// Availability treats stored Cookie times as floating wall times. A caller
// must choose their interpretation zone; no original timezone is implied.
export const DAY_MS = 86_400_000;

/** @param {unknown} zone */
export function validTimeZone(zone) {
  if (typeof zone !== 'string' || zone.length > 100 || !/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(zone))
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format();
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} date */
export function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** @param {string} date @param {number} days */
export function addDays(date, days) {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** @param {string} zone */
export function wallClock(zone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return (/** @type {number | Date} */ instant) => {
    const parts = formatter.formatToParts(instant);
    const part = (/** @type {string} */ type) => parts.find((p) => p.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
  };
}

/**
 * Round trip all nearby offsets. Zero matches is a DST gap, two is an
 * ambiguous repeated hour. Neither can safely be guessed for free/busy.
 * @param {string} date
 * @param {string} time
 * @param {string} zone
 */
export function wallTimeToInstant(date, time, zone) {
  if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) {
    throw new Error('Invalid calendar time');
  }
  const expected = `${date}T${time.length === 5 ? `${time}:00` : time}`;
  const nominal = new Date(`${expected}Z`).getTime();
  const format = wallClock(zone);
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = nominal + hours * 3_600_000;
    offsets.add(new Date(`${format(probe)}Z`).getTime() - probe);
  }
  const matches = [...offsets]
    .map((offset) => nominal - offset)
    .filter((t) => format(t) === expected);
  if (matches.length !== 1) throw new Error('Ambiguous or nonexistent calendar time');
  return matches[0];
}

/** @param {{start: number, end: number}[]} busy */
export function mergeBusy(busy) {
  /** @type {{start: number, end: number}[]} */
  const merged = [];
  for (const interval of busy.toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}
