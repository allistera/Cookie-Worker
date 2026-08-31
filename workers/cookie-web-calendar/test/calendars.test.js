import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ported from Cookie-Web's api/__tests__/calendars.test.js — the same scripted
// query sequences and expectations, calling the Response-style handlers the
// (req, res) handler became.
import {
  createCalendar,
  deleteCalendar,
  fetchCalendars,
  listCalendars,
  renameCalendar,
} from '../src/calendars.js';

// Each tagged-template query resolves to the next queued result, so a test
// can script the sequence of reads/writes the handler issues in order.
// sql.begin(fn) runs fn against the same queue-consuming function, since
// none of these tests need real transactional isolation.
/** @type {any[]} */
let sqlQueue = [];
/** @type {{text: string, values: unknown[]}[]} */
const queriesRun = [];
function makeSql() {
  /** @type {any} */
  const run = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => {
    queriesRun.push({ text: strings.join('?'), values });
    return Promise.resolve(sqlQueue.shift() ?? []);
  };
  run.begin = async (/** @type {(sql: any) => unknown} */ fn) => fn(run);
  return run;
}

const USER_ID = '99999999-9999-9999-9999-999999999999';
const CALENDAR_ID = '11111111-1111-1111-1111-111111111111';
// createCalendar's sync seam is irrelevant to these cases; it must never run.
const neverSync = vi.fn(async () => ({ ok: true, count: 0 }));
const env = /** @type {import('../src/sentry.js').CalendarEnv} */ ({});

beforeEach(() => {
  sqlQueue = [];
  queriesRun.length = 0;
  neverSync.mockClear();
});

describe('fetchCalendars', () => {
  it('reads the calendars table scoped to the user, oldest first', () => {
    let query = '';
    /** @type {unknown[]} */
    const values = [];
    /** @type {any} */
    const sql = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...vals) => {
      query = strings.join('?');
      values.push(...vals);
      return [];
    };

    fetchCalendars(sql, USER_ID);

    expect(query).toContain('FROM calendars c');
    expect(query).toContain('WHERE c.user_id =');
    expect(query).toContain('ORDER BY c.created_at, c.id');
    expect(values).toEqual([USER_ID]);
  });
});

describe('GET calendar management', () => {
  it('returns existing calendars without seeding', async () => {
    sqlQueue = [[{ id: CALENDAR_ID, name: 'Work', color: '#4f7c6b' }]];
    const response = await listCalendars(makeSql(), USER_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      calendars: [{ id: CALENDAR_ID, name: 'Work', color: '#4f7c6b' }],
    });
  });

  it('seeds five default calendars for a user with none yet', async () => {
    const defaults = [
      { id: 'id-1', name: 'Work', color: '#4f7c6b' },
      { id: 'id-2', name: 'Personal', color: '#2db985' },
      { id: 'id-3', name: 'Focus time', color: '#795da8' },
      { id: 'id-4', name: 'Birthdays', color: '#d8953b' },
      { id: 'id-5', name: 'Holidays', color: '#d15c4e' },
    ];
    sqlQueue = [
      [], // fetchCalendars: empty
      [], // one atomic INSERT
      defaults, // canonical refetch
    ];
    const response = await listCalendars(makeSql(), USER_ID);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.calendars).toHaveLength(5);
    expect(body.calendars.map((/** @type {{name: string}} */ c) => c.name)).toEqual([
      'Work',
      'Personal',
      'Focus time',
      'Birthdays',
      'Holidays',
    ]);
  });

  it('returns legacy defaults while the expand migration is still pending', async () => {
    sqlQueue = [Promise.reject(Object.assign(new Error('missing table'), { code: '42P01' }))];
    const response = await listCalendars(makeSql(), USER_ID);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.calendars.map((/** @type {{id: string}} */ calendar) => calendar.id)).toEqual([
      'work',
      'personal',
      'focus',
      'birthdays',
      'holidays',
    ]);
  });
});

describe('POST calendar management', () => {
  it('creates a calendar', async () => {
    sqlQueue = [[{ id: CALENDAR_ID, name: 'Trips', color: '#3b82f6' }]];
    const response = await createCalendar(
      makeSql(),
      USER_ID,
      { name: 'Trips', color: '#3b82f6' },
      env,
      neverSync,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      calendar: { id: CALENDAR_ID, name: 'Trips', color: '#3b82f6' },
    });
    expect(neverSync).not.toHaveBeenCalled();
  });

  it('409s when the insert is skipped by the unique constraint', async () => {
    sqlQueue = [[]];
    const response = await createCalendar(
      makeSql(),
      USER_ID,
      { name: 'Work', color: '#3b82f6' },
      env,
      neverSync,
    );

    expect(response.status).toBe(409);
  });

  it('rejects a missing name or invalid color with 400', async () => {
    const first = await createCalendar(
      makeSql(),
      USER_ID,
      { name: '', color: '#3b82f6' },
      env,
      neverSync,
    );
    expect(first.status).toBe(400);

    const second = await createCalendar(
      makeSql(),
      USER_ID,
      { name: 'Trips', color: 'not-a-color' },
      env,
      neverSync,
    );
    expect(second.status).toBe(400);
  });
});

describe('PATCH calendar management', () => {
  it('renames a calendar', async () => {
    sqlQueue = [[{ id: CALENDAR_ID, name: 'Travel', color: '#3b82f6' }]];
    const response = await renameCalendar(makeSql(), USER_ID, { id: CALENDAR_ID, name: 'Travel' });

    expect(response.status).toBe(200);
    expect((await response.json()).calendar.name).toBe('Travel');
  });

  it('404s when the calendar is not the caller’s', async () => {
    sqlQueue = [[]];
    const response = await renameCalendar(makeSql(), USER_ID, { id: CALENDAR_ID, name: 'Travel' });

    expect(response.status).toBe(404);
  });

  it('409s on a duplicate-name unique violation', async () => {
    sqlQueue = [Promise.reject(Object.assign(new Error('duplicate'), { code: '23505' }))];
    const response = await renameCalendar(makeSql(), USER_ID, { id: CALENDAR_ID, name: 'Work' });

    expect(response.status).toBe(409);
  });

  it('rejects a malformed id or empty name with 400', async () => {
    const first = await renameCalendar(makeSql(), USER_ID, { id: 'not-a-uuid', name: 'Travel' });
    expect(first.status).toBe(400);

    const second = await renameCalendar(makeSql(), USER_ID, { id: CALENDAR_ID, name: '' });
    expect(second.status).toBe(400);
  });
});

describe('DELETE calendar management', () => {
  it('deletes a calendar with no events', async () => {
    sqlQueue = [
      [{ isSubscribed: false }], // ownership + subscription check
      [{ count: 0 }], // event count
      [], // DELETE
    ];
    const response = await deleteCalendar(makeSql(), USER_ID, { id: CALENDAR_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('409s if the database FK catches a concurrent event create', async () => {
    sqlQueue = [
      [{ isSubscribed: false }],
      [{ count: 0 }],
      Promise.reject(Object.assign(new Error('still referenced'), { code: '23503' })),
    ];
    const response = await deleteCalendar(makeSql(), USER_ID, { id: CALENDAR_ID });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('events');
  });

  it('409s with the event count when the calendar still has events', async () => {
    sqlQueue = [[{ isSubscribed: false }], [{ count: 3 }]];
    const response = await deleteCalendar(makeSql(), USER_ID, { id: CALENDAR_ID });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('3 events');
  });

  it('404s when the calendar is not the caller’s', async () => {
    sqlQueue = [[]];
    const response = await deleteCalendar(makeSql(), USER_ID, { id: CALENDAR_ID });

    expect(response.status).toBe(404);
  });

  it('cascade-deletes a subscribed calendar even though it has events, skipping the event-count check', async () => {
    sqlQueue = [[{ isSubscribed: true }]];
    const response = await deleteCalendar(makeSql(), USER_ID, { id: CALENDAR_ID });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(queriesRun.some((q) => q.text.includes('DELETE FROM calendar_events'))).toBe(true);
    expect(queriesRun.some((q) => q.text.includes('DELETE FROM calendars'))).toBe(true);
    expect(queriesRun.some((q) => q.text.includes('count(*)'))).toBe(false);
  });

  it('rejects a malformed id with 400', async () => {
    const response = await deleteCalendar(makeSql(), USER_ID, { id: 'not-a-uuid' });

    expect(response.status).toBe(400);
  });
});
