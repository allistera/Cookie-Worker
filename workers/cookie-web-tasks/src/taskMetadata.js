const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** @param {unknown} value */
export function isTaskTimeZone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} value */
export function normalizeTaskLabels(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Use at most 20 task labels');
  const labels = value.map((label) => {
    if (typeof label !== 'string') throw new Error('Labels must be text');
    const text = label.trim().replace(/^@/, '').toLowerCase();
    const hasControlCharacter = [...text].some((character) => character.charCodeAt(0) < 32);
    if (!text || text.length > 40 || /[\s@#]/u.test(text) || hasControlCharacter) {
      throw new Error('Labels must be 1–40 characters without spaces, @, or #');
    }
    return text;
  });
  return [...new Set(labels)];
}

/** @param {{dueDate?: string | null, dueTime?: any, timeZone?: any, labels?: any}} value */
export function normalizeTaskMetadata(value) {
  const dueTime = value.dueTime === '' ? null : (value.dueTime ?? null);
  const timeZone = value.timeZone === '' ? null : (value.timeZone ?? null);
  if (dueTime !== null && (typeof dueTime !== 'string' || !TIME_RE.test(dueTime))) {
    throw new Error('Due time must be HH:MM in 24-hour time');
  }
  if (dueTime !== null && (!value.dueDate || !isTaskTimeZone(timeZone))) {
    throw new Error('A due time requires a due date and valid time zone');
  }
  return {
    dueTime,
    timeZone: dueTime === null ? null : timeZone,
    labels: normalizeTaskLabels(value.labels ?? []),
  };
}
