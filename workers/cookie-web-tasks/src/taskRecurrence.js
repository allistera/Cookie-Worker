// Task schedules are date-only. UTC arithmetic avoids DST changing calendar days.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', 'last'];
const DAY_MS = 86400000;

/** @param {unknown} value */
export function parseTaskRecurrence(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const text = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const normalized = text === 'daily' ? 'every day' : text === 'weekly' ? 'every week' : text;
  const interval = /^every (?:(\d+) )?(day|week)s?$/.exec(normalized);
  if (interval) {
    const count = Number(interval[1] ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > 365) return null;
    return {
      text: `every ${count === 1 ? '' : `${count} `}${interval[2]}${count === 1 ? '' : 's'}`,
      days: count * (interval[2] === 'week' ? 7 : 1),
    };
  }
  const weekday =
    /^every (?:(1st|2nd|3rd|4th|5th|last) )?([a-z]+)(?: of (?:the |each )?month)?$/.exec(
      normalized,
    );
  if (!weekday) return null;
  const day = WEEKDAYS.indexOf(weekday[2]);
  if (day < 0 || (!weekday[1] && normalized.endsWith('month'))) return null;
  return {
    text: `every ${weekday[1] ? `${weekday[1]} ` : ''}${WEEKDAYS[day]}`,
    weekday: day,
    ordinal: weekday[1] ? ORDINALS.indexOf(weekday[1]) + 1 : null,
  };
}

/** @param {string} value */
function date(value) {
  const result = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(+result) || format(result) !== value) {
    throw new Error('A valid calendar date is required');
  }
  return result;
}

/** @param {Date} value */
function format(value) {
  const text = value.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Schedule exceeds supported dates');
  return text;
}

/**
 * First occurrence on/after `from`. With `after`, advance strictly beyond both
 * the current due date and the completion date, preserving the interval phase.
 * A fifth weekday skips months without one; last means the final weekday.
 * @param {string} recurrence
 * @param {string} from
 * @param {string | null} [after]
 */
export function taskOccurrence(recurrence, from, after = null) {
  const rule = parseTaskRecurrence(recurrence);
  if (!rule) throw new Error('Unsupported repeat schedule');
  const start = date(from);
  const threshold = after === null ? +start : Math.max(+start, +date(after)) + DAY_MS;
  if (rule.days !== undefined) {
    return format(
      new Date(
        +start + Math.ceil((threshold - +start) / (rule.days * DAY_MS)) * rule.days * DAY_MS,
      ),
    );
  }
  const candidate = new Date(threshold);
  if (!rule.ordinal) {
    candidate.setUTCDate(candidate.getUTCDate() + ((rule.weekday - candidate.getUTCDay() + 7) % 7));
    return format(candidate);
  }
  candidate.setUTCDate(1);
  // At most a few months are needed for a fifth weekday.
  for (let month = 0; month < 12; month++) {
    const occurrence = new Date(+candidate);
    if (rule.ordinal === 6) {
      occurrence.setUTCMonth(occurrence.getUTCMonth() + 1, 0);
      occurrence.setUTCDate(
        occurrence.getUTCDate() - ((occurrence.getUTCDay() - rule.weekday + 7) % 7),
      );
    } else {
      occurrence.setUTCDate(
        1 + ((rule.weekday - occurrence.getUTCDay() + 7) % 7) + (rule.ordinal - 1) * 7,
      );
    }
    if (occurrence.getUTCMonth() === candidate.getUTCMonth() && +occurrence >= threshold)
      return format(occurrence);
    candidate.setUTCMonth(candidate.getUTCMonth() + 1);
  }
  throw new Error('No next occurrence found');
}
