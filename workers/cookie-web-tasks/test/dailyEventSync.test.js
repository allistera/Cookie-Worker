import { describe, expect, it } from 'vitest';
import {
  dateKey,
  extractTimeLines,
  parseTimeLine,
  resolveDailyNoteEventDate,
  resolveDefaultCalendarId,
  syncDailyNoteEvents,
} from '../src/dailyEventSync.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const FOLDER_ID = '33333333-3333-4333-8333-333333333333';

// Sequential-queue tagged-template fake: each call resolves to the next
// queued result and records its SQL text, mirroring documents.test.js.
// Loosely typed (`any`) so it can stand in wherever the real Sql/TransactionSql
// type is expected.
/** @param {unknown[][]} results */
function queueSql(...results) {
  const queue = [...results];
  /** @type {string[]} */
  const statements = [];
  /** @type {any} */
  const sql = (/** @type {any} */ strings) => {
    statements.push(strings.join('?'));
    return Promise.resolve(queue.shift() ?? []);
  };
  sql.statements = statements;
  return sql;
}

/** @param {ReturnType<typeof parseTimeLine>} value */
function assertParsed(value) {
  if (!value) throw new Error('expected parseTimeLine to return a non-null result');
  return value;
}

describe('parseTimeLine', () => {
  it('parses a start-end-title range', () => {
    expect(parseTimeLine('10:00 - 11:00 - Team sync')).toEqual({ start: '10:00', durationMinutes: 60, title: 'Team sync' });
  });

  it('does not let the range pattern swallow the end time into a single-time title', () => {
    const result = assertParsed(parseTimeLine('10:00 - 11:00 - Team sync'));
    expect(result.title).toBe('Team sync');
    expect(result.durationMinutes).toBe(60);
  });

  it('falls back to a single time with a 30-minute default duration', () => {
    expect(parseTimeLine('9:05 - Standup')).toEqual({ start: '09:05', durationMinutes: 30, title: 'Standup' });
  });

  it('strips inline HTML and decodes entities before matching', () => {
    expect(parseTimeLine('10:00 - 11:00 - <b>Team</b> sync &amp; planning')).toEqual({
      start: '10:00',
      durationMinutes: 60,
      title: 'Team sync & planning',
    });
  });

  it('rejects an end time at or before the start time', () => {
    expect(parseTimeLine('11:00 - 10:00 - Team sync')).toBeNull();
    expect(parseTimeLine('10:00 - 10:00 - Team sync')).toBeNull();
  });

  it('rejects out-of-range hours or minutes', () => {
    expect(parseTimeLine('25:00 - Team sync')).toBeNull();
    expect(parseTimeLine('10:75 - Team sync')).toBeNull();
  });

  it('rejects an empty title', () => {
    expect(parseTimeLine('10:00 - 11:00 -    ')).toBeNull();
    expect(parseTimeLine('10:00 -    ')).toBeNull();
  });

  it('returns null for text with no time prefix', () => {
    expect(parseTimeLine('Just a note about the renovation')).toBeNull();
    expect(parseTimeLine('')).toBeNull();
    expect(parseTimeLine(undefined)).toBeNull();
  });
});

describe('extractTimeLines', () => {
  it('keys matching paragraph blocks by their block id', () => {
    const lines = extractTimeLines([
      { id: 'b1', type: 'paragraph', data: { text: '10:00 - 11:00 - Team sync' } },
      { id: 'b2', type: 'header', data: { text: '10:00 - 11:00 - Not a paragraph' } },
      { id: 'b3', type: 'paragraph', data: { text: 'No time here' } },
      { id: 'b4', type: 'paragraph', data: { text: '14:00 - Focus block' } },
    ]);
    expect([...lines.keys()]).toEqual(['b1', 'b4']);
    expect(lines.get('b1').title).toBe('Team sync');
    expect(lines.get('b4').durationMinutes).toBe(30);
  });

  it('skips blocks with no usable id', () => {
    const lines = extractTimeLines([
      { type: 'paragraph', data: { text: '10:00 - 11:00 - Team sync' } },
      { id: 42, type: 'paragraph', data: { text: '10:00 - 11:00 - Team sync' } },
    ]);
    expect(lines.size).toBe(0);
  });

  it('returns an empty map for no blocks', () => {
    expect(extractTimeLines(undefined).size).toBe(0);
    expect(extractTimeLines([]).size).toBe(0);
  });

  it('extracts matching lines from a flat bulleted/checklist list, keyed by position', () => {
    const lines = extractTimeLines([
      {
        id: 'list-1',
        type: 'list',
        data: {
          style: 'checklist',
          items: [
            { content: '09:00 - Standup', meta: { checked: false } },
            { content: 'Just a plain task, no time', meta: { checked: false } },
            { content: '10:00 - 10:30 - Design review', meta: { checked: true } },
          ],
        },
      },
    ]);
    expect([...lines.keys()]).toEqual(['list-1:0', 'list-1:2']);
    expect(lines.get('list-1:0')).toEqual({ start: '09:00', durationMinutes: 30, title: 'Standup' });
    expect(lines.get('list-1:2')).toEqual({ start: '10:00', durationMinutes: 30, title: 'Design review' });
  });

  it('recurses into nested sub-items with a path-shaped key', () => {
    const lines = extractTimeLines([
      {
        id: 'list-1',
        type: 'list',
        data: {
          style: 'unordered',
          items: [
            {
              content: 'Morning',
              items: [
                { content: '09:00 - Standup', items: [] },
                { content: '09:30 - 10:00 - Review PRs', items: [] },
              ],
            },
          ],
        },
      },
    ]);
    expect([...lines.keys()]).toEqual(['list-1:0:0', 'list-1:0:1']);
    expect(lines.get('list-1:0:0').title).toBe('Standup');
    expect(lines.get('list-1:0:1').title).toBe('Review PRs');
  });

  it('combines paragraph and list blocks in one document without key collisions', () => {
    const lines = extractTimeLines([
      { id: 'p1', type: 'paragraph', data: { text: '08:00 - Gym' } },
      { id: 'list-1', type: 'list', data: { style: 'unordered', items: [{ content: '09:00 - Standup' }] } },
    ]);
    expect([...lines.keys()].sort()).toEqual(['list-1:0', 'p1']);
  });

  it('ignores a list block with no items array', () => {
    expect(extractTimeLines([{ id: 'list-1', type: 'list', data: {} }]).size).toBe(0);
  });
});

describe('dateKey', () => {
  it('formats a local date as YYYY-MM-DD', () => {
    expect(dateKey(new Date(2026, 7, 3))).toBe('2026-08-03');
  });
});

describe('resolveDailyNoteEventDate', () => {
  it('returns null without a query when the title is not a daily-note title', async () => {
    const sql = queueSql();
    await expect(resolveDailyNoteEventDate(sql, USER_ID, FOLDER_ID, 'Project notes')).resolves.toBeNull();
    expect(sql.statements).toHaveLength(0);
  });

  it('returns null when the root folder is not "Daily"', async () => {
    const sql = queueSql([{ title: 'Projects' }]);
    await expect(resolveDailyNoteEventDate(sql, USER_ID, FOLDER_ID, '14-08-26')).resolves.toBeNull();
  });

  it('returns the event date when the title and root folder both match', async () => {
    const sql = queueSql([{ title: 'Daily' }]);
    await expect(resolveDailyNoteEventDate(sql, USER_ID, FOLDER_ID, '14-08-26')).resolves.toBe('2026-08-14');
  });
});

describe('resolveDefaultCalendarId', () => {
  it('prefers a calendar named Personal over the oldest writable one', async () => {
    const sql = queueSql([{ id: 'cal-personal' }]);
    await expect(resolveDefaultCalendarId(sql, USER_ID)).resolves.toBe('cal-personal');
    expect(sql.statements[0]).toContain("name = 'Personal'");
    expect(sql.statements[0]).toContain('subscription_url IS NULL');
  });

  it('returns null when the user has no writable calendar', async () => {
    const sql = queueSql([]);
    await expect(resolveDefaultCalendarId(sql, USER_ID)).resolves.toBeNull();
  });
});

describe('syncDailyNoteEvents', () => {
  const oldBlocks = [
    { id: 'keep', type: 'paragraph', data: { text: '09:00 - Standup' } },
    { id: 'removed', type: 'paragraph', data: { text: '10:00 - 10:30 - Old meeting' } },
  ];

  it('deletes events for lines removed from the document', async () => {
    const newBlocks = [oldBlocks[0]];
    const sql = queueSql([], [{ id: 'cal-personal' }], []);

    await syncDailyNoteEvents(sql, USER_ID, DOC_ID, '2026-08-14', oldBlocks, newBlocks);

    expect(sql.statements[0]).toContain('DELETE FROM calendar_events');
  });

  it('upserts a new or changed line with the resolved calendar', async () => {
    const sql = queueSql([], [{ id: 'cal-personal' }], []);

    await syncDailyNoteEvents(sql, USER_ID, DOC_ID, '2026-08-14', oldBlocks, [oldBlocks[0]]);

    const upsert = sql.statements.at(-1);
    expect(upsert).toContain('INSERT INTO calendar_events');
    expect(upsert).toContain('ON CONFLICT (source_document_id, source_block_id)');
    expect(upsert).toContain('DO UPDATE SET');
  });

  it('does nothing when neither old nor new blocks have any time lines', async () => {
    const sql = queueSql();
    await syncDailyNoteEvents(sql, USER_ID, DOC_ID, '2026-08-14', [], []);
    expect(sql.statements).toHaveLength(0);
  });

  it('skips creating events when the user has no writable calendar', async () => {
    const newBlocks = [{ id: 'b1', type: 'paragraph', data: { text: '09:00 - Standup' } }];
    const sql = queueSql([]);
    await syncDailyNoteEvents(sql, USER_ID, DOC_ID, '2026-08-14', [], newBlocks);

    expect(sql.statements).toHaveLength(1);
  });
});
