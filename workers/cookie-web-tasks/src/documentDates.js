// Ported from Cookie-Web's src/lib/documentDates.js — pure JS, no Node APIs.
// Only parseDailyNoteDate is ported: the rest of that file (formatting
// helpers for the "/" Date block and Daily-note titles/folders) is a
// frontend-only concern, never called server-side.

const DAILY_NOTE_TITLE_RE = /^(\d{2})-(\d{2})-(\d{2})$/;

/**
 * Daily note title, e.g. "13-08-26" -> Date(2026, 7, 13). Returns null for
 * anything that isn't that exact shape, including a title that looks close
 * but names a calendar date that doesn't exist (e.g. "31-02-26").
 *
 * @param {string | null | undefined} title
 */
export function parseDailyNoteDate(title) {
  const match = DAILY_NOTE_TITLE_RE.exec(title ?? '');
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(2000 + Number(year), Number(month) - 1, Number(day));
  if (date.getDate() !== Number(day) || date.getMonth() !== Number(month) - 1) return null;
  return date;
}
