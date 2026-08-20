// Ported verbatim from Cookie-Web's api/_lib/dailyEventSync.js — pure JS +
// SQL, no Node APIs.
//
// A line typed into a Daily note (a plain paragraph, or an item in a
// bulleted/numbered/checklist list, at any nesting depth) auto-creates/
// updates/deletes a linked calendar_events row, keyed by where it lives in
// the document (source_document_id/source_block_id). The actual
// line-matching rules live in dailyEventLines.js.

import { parseDailyNoteDate } from './documentDates.js';
import { matchTimeLine } from './dailyEventLines.js';

/** @typedef {import('postgres').Sql | import('postgres').TransactionSql} SqlClient */

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0');

// Editor.js paragraph/list-item text is HTML (inline bold/italic/link markup
// from the toolbar) — strip tags before matching or extracting a title so
// formatting can't break the pattern or leak markup into the event title.
/** @param {any} html */
function plainText(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/** @param {any} text */
export function parseTimeLine(text) {
  return matchTimeLine(plainText(text));
}

// @editorjs/list (bullet/numbered/checklist — one tool, one block type,
// covering all three styles) gives the *block* an id but never its
// individual items: data.items is a plain (recursively nestable) array with
// no per-item identity of its own. A positional path (block id + each
// nesting level's index) is the closest thing to a stable key available —
// stable across an edit in place or an append at the end, but not across
// reordering or inserting/deleting a bullet above an existing one, which
// reads as that item's old key disappearing and a new one appearing at the
// shifted position (delete the old event, create a new one — never silently
// wrong, just loses the old row's identity across the edit).
/**
 * @param {any[]} items
 * @param {string} keyPrefix
 * @param {Map<string, any>} lines
 */
const MAX_LIST_DEPTH = 16;

function collectListItemLines(items, keyPrefix, lines, depth = 0) {
  if (depth > MAX_LIST_DEPTH) return;
  items.forEach((item, index) => {
    const key = `${keyPrefix}:${index}`;
    const line = parseTimeLine(item?.content);
    if (line) lines.set(key, line);
    if (Array.isArray(item?.items) && item.items.length > 0) {
      collectListItemLines(item.items, key, lines, depth + 1);
    }
  });
}

/** @param {any[] | null | undefined} blocks */
export function extractTimeLines(blocks) {
  const lines = new Map();
  for (const block of blocks ?? []) {
    const id = block?.id;
    // Identity check (not just a truthy value) keeps a non-string id that
    // coerces into a plausible key, e.g. a number, out of the Map.
    if (!id || id !== String(id)) continue;
    if (block.type === 'paragraph') {
      const line = parseTimeLine(block.data?.text);
      if (line) lines.set(id, line);
    } else if (block.type === 'list' && Array.isArray(block.data?.items)) {
      collectListItemLines(block.data.items, id, lines);
    }
  }
  return lines;
}

// Local (not UTC) date key — parseDailyNoteDate returns a local Date, and
// event_date must name the calendar day the note is actually about.
/** @param {Date} date */
export function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * The date a Daily note (Daily/<year>/<month>/DD-MM-YY) represents, as an
 * event_date-ready string, or null for any other document — mirrors
 * Cookie-Web's src/stores/documents.js's openDocDailyDate getter,
 * server-side.
 *
 * @param {SqlClient} sql
 * @param {string} userId
 * @param {string | null} folderId
 * @param {string} title
 */
export async function resolveDailyNoteEventDate(sql, userId, folderId, title) {
  const date = parseDailyNoteDate(title);
  if (!date || folderId === null || folderId === undefined) return null;
  const [root] = await sql`
    WITH RECURSIVE ancestry AS (
      SELECT id, parent_id, title FROM document_folders WHERE id = ${folderId} AND user_id = ${userId}
      UNION ALL
      SELECT f.id, f.parent_id, f.title FROM document_folders f
      JOIN ancestry a ON f.id = a.parent_id
    )
    SELECT title FROM ancestry WHERE parent_id IS NULL
  `;
  return root?.title === 'Daily' ? dateKey(date) : null;
}

/**
 * Prefers a calendar named "Personal" (the app's seeded default); falls
 * back to the user's oldest non-subscription calendar. Returns null only if
 * the user somehow has no writable calendar at all, in which case
 * syncDailyNoteEvents skips creating anything rather than erroring the
 * whole document save over it.
 *
 * @param {SqlClient} sql
 * @param {string} userId
 */
export async function resolveDefaultCalendarId(sql, userId) {
  const [calendar] = await sql`
    SELECT id FROM calendars
    WHERE user_id = ${userId} AND subscription_url IS NULL
    ORDER BY (name = 'Personal') DESC, created_at ASC
    LIMIT 1
  `;
  return calendar?.id ?? null;
}

/**
 * Diffs the time-range lines in a Daily note's old vs. new blocks and
 * applies the difference to calendar_events within the caller's
 * transaction. eventDate is the note's own date
 * (resolveDailyNoteEventDate), not "today".
 *
 * @param {SqlClient} sql
 * @param {string} userId
 * @param {string} documentId
 * @param {string} eventDate
 * @param {any[]} oldBlocks
 * @param {any[]} newBlocks
 */
export async function syncDailyNoteEvents(
  sql,
  userId,
  documentId,
  eventDate,
  oldBlocks,
  newBlocks,
) {
  const oldLines = extractTimeLines(oldBlocks);
  const newLines = extractTimeLines(newBlocks);

  for (const blockId of oldLines.keys()) {
    if (!newLines.has(blockId)) {
      await sql`
        DELETE FROM calendar_events
        WHERE source_document_id = ${documentId}
          AND source_block_id = ${blockId}
          AND user_id = ${userId}
      `;
    }
  }

  if (newLines.size === 0) return;

  const calendarId = await resolveDefaultCalendarId(sql, userId);
  if (!calendarId) return;

  for (const [blockId, line] of newLines) {
    await sql`
      INSERT INTO calendar_events (
        user_id, title, event_date, start_time, duration_minutes, calendar,
        source_document_id, source_block_id
      )
      VALUES (
        ${userId}, ${line.title}, ${eventDate}, ${line.start}, ${line.durationMinutes}, ${calendarId},
        ${documentId}, ${blockId}
      )
      ON CONFLICT (source_document_id, source_block_id) WHERE source_document_id IS NOT NULL
      DO UPDATE SET
        title = EXCLUDED.title,
        event_date = EXCLUDED.event_date,
        start_time = EXCLUDED.start_time,
        duration_minutes = EXCLUDED.duration_minutes,
        updated_at = now()
    `;
  }
}
