import { describe, expect, test } from 'vitest';
import { ToolInputError } from '../src/results.js';
import { tools } from '../src/tools/calendar.js';
import { byName, fakeApi } from './helpers.js';

const SERIES = '11111111-1111-4111-8111-111111111111';
const CAL = '22222222-2222-4222-8222-222222222222';

/** @param {string} name @param {any} args @param {any} api */
async function call(name, args, api) {
  const tool = byName(tools, name);
  const result = await tool.run(tool.inputSchema.parse(args), api);
  tool.outputSchema.parse(result);
  return result;
}

const eventRow = {
  id: SERIES,
  title: 'Standup',
  description: null,
  location: null,
  date: '2026-10-05',
  start: '09:30',
  duration: 15,
  calendar: CAL,
  tone: null,
  recurrenceRule: null,
  allDay: false,
  autoScheduled: false,
};
const fields = {
  title: 'Standup',
  date: '2026-10-05',
  start: '09:30',
  durationMinutes: 15,
  calendar: CAL,
};

describe('calendar tools', () => {
  test('cookie_list_calendars maps read-only subscriptions, including legacy slug ids', async () => {
    const api = fakeApi();
    api.calendar.get.mockResolvedValue({
      calendars: [
        {
          id: CAL,
          name: 'Work',
          color: '#fff',
          subscriptionUrl: null,
          subscriptionSyncedAt: null,
          subscriptionError: null,
        },
        {
          id: 'holidays',
          name: 'Holidays',
          color: null,
          subscriptionUrl: 'https://example.com/a.ics',
          subscriptionSyncedAt: '2026-10-01T00:00:00.000Z',
          subscriptionError: null,
        },
      ],
    });
    const result = await call('cookie_list_calendars', {}, api);
    expect(api.calendar.get).toHaveBeenCalledWith('/calendars');
    expect(result).toEqual({
      calendars: [
        { id: CAL, name: 'Work', color: '#fff', readOnly: false },
        { id: 'holidays', name: 'Holidays', color: null, readOnly: true },
      ],
    });
  });

  test('cookie_list_events leaves the calendar filter off when none is given', async () => {
    const api = fakeApi();
    api.calendar.get.mockResolvedValue({ events: [], truncated: false });
    await call('cookie_list_events', { from: '2026-10-01', to: '2026-10-31' }, api);
    expect(api.calendar.get).toHaveBeenCalledWith('/calendar-events', {
      from: '2026-10-01',
      to: '2026-10-31',
      calendar: undefined,
    });
  });

  test('cookie_list_events reports the server truncating the filtered calendar', async () => {
    const api = fakeApi();
    api.calendar.get.mockResolvedValue({ events: [eventRow], truncated: true });
    const result = await call(
      'cookie_list_events',
      { from: '2026-10-01', to: '2026-10-31', calendar: CAL },
      api,
    );
    expect(result.events).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  test('cookie_list_events queries the range, filters by calendar and applies limit', async () => {
    const api = fakeApi();
    const other = { ...eventRow, calendar: 'work', seriesId: SERIES };
    api.calendar.get.mockResolvedValue({
      events: [{ ...eventRow, seriesId: SERIES }, other, { ...other, id: 'x' }],
      truncated: false,
    });
    const result = await call(
      'cookie_list_events',
      { from: '2026-10-01', to: '2026-10-31', calendar: 'work', limit: 1 },
      api,
    );
    // The filter goes to the calendar worker, which applies it before its
    // recurrence expansion cap.
    expect(api.calendar.get).toHaveBeenCalledWith('/calendar-events', {
      from: '2026-10-01',
      to: '2026-10-31',
      calendar: 'work',
    });
    expect(result.events).toEqual([
      {
        id: SERIES,
        seriesId: SERIES,
        title: 'Standup',
        date: '2026-10-05',
        start: '09:30',
        durationMinutes: 15,
        calendar: 'work',
        location: null,
        description: null,
        tone: null,
        recurrenceRule: null,
        repeat: 'none',
        repeatUntil: null,
        repeatDays: null,
        allDay: false,
      },
    ]);
    expect(result.truncated).toBe(true);
  });

  test('cookie_list_events decodes the recurrence rule and passes seriesDate and tone', async () => {
    const api = fakeApi();
    // An occurrence row as recurrence.js emits it: its own date, plus the series start.
    api.calendar.get.mockResolvedValue({
      events: [
        {
          ...eventRow,
          id: `${SERIES}:2026-10-07`,
          seriesId: SERIES,
          seriesDate: '2026-10-05',
          date: '2026-10-07',
          tone: 'accepted',
          recurrenceRule: 'WEEKLY;BYDAY=MO,WE;UNTIL=2026-12-31',
        },
        { ...eventRow, id: 'x', seriesId: 'x', recurrenceRule: 'MONTHLY' },
      ],
      truncated: false,
    });
    const result = await call('cookie_list_events', { from: '2026-10-01', to: '2026-10-31' }, api);
    expect(result.events[0]).toMatchObject({
      id: `${SERIES}:2026-10-07`,
      seriesId: SERIES,
      seriesDate: '2026-10-05',
      date: '2026-10-07',
      tone: 'accepted',
      recurrenceRule: 'WEEKLY;BYDAY=MO,WE;UNTIL=2026-12-31',
      repeat: 'weekly',
      repeatDays: ['MO', 'WE'],
      repeatUntil: '2026-12-31',
    });
    expect(result.events[1]).toMatchObject({
      repeat: 'monthly',
      repeatDays: null,
      repeatUntil: null,
    });
    expect(result.events[1]).not.toHaveProperty('seriesDate');
  });

  test('cookie_list_events passes through the API truncated flag and null-valued rows', async () => {
    const api = fakeApi();
    api.calendar.get.mockResolvedValue({ events: [eventRow], truncated: true });
    const result = await call('cookie_list_events', { from: '2026-10-01', to: '2026-10-31' }, api);
    expect(result.truncated).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  test('cookie_list_events rejects a span over 1095 days and a reversed range', async () => {
    const api = fakeApi();
    const run = (/** @type {any} */ args) => call('cookie_list_events', args, api);
    await expect(run({ from: '2020-01-01', to: '2026-01-01' })).rejects.toThrow(ToolInputError);
    await expect(run({ from: '2026-10-31', to: '2026-10-01' })).rejects.toThrow(ToolInputError);
    expect(api.calendar.get).not.toHaveBeenCalled();
    // Exactly 1095 days is accepted.
    api.calendar.get.mockResolvedValue({ events: [], truncated: false });
    await expect(run({ from: '2023-01-01', to: '2025-12-31' })).resolves.toEqual({
      events: [],
      truncated: false,
    });
  });

  test('cookie_create_event posts the mapped body and omits unset fields', async () => {
    const api = fakeApi();
    api.calendar.post.mockResolvedValue({ event: eventRow });
    const result = await call('cookie_create_event', fields, api);
    expect(api.calendar.post).toHaveBeenCalledWith('/calendar-events', {
      title: 'Standup',
      date: '2026-10-05',
      start: '09:30',
      duration: 15,
      calendar: CAL,
      repeat: 'none',
    });
    expect(result).toEqual({ event: eventRow });
  });

  test('cookie_create_event sends recurrence fields', async () => {
    const api = fakeApi();
    api.calendar.post.mockResolvedValue({
      event: { ...eventRow, recurrenceRule: 'WEEKLY;BYDAY=MO,WE' },
    });
    await call(
      'cookie_create_event',
      {
        ...fields,
        description: 'd',
        location: 'l',
        repeat: 'weekly',
        repeatUntil: '2026-12-31',
        repeatDays: ['MO', 'WE'],
      },
      api,
    );
    expect(api.calendar.post).toHaveBeenCalledWith('/calendar-events', {
      title: 'Standup',
      date: '2026-10-05',
      start: '09:30',
      duration: 15,
      calendar: CAL,
      description: 'd',
      location: 'l',
      repeat: 'weekly',
      repeatUntil: '2026-12-31',
      repeatDays: ['MO', 'WE'],
    });
  });

  test('repeatDays without weekly repeat is rejected before any call', async () => {
    const api = fakeApi();
    await expect(
      call('cookie_create_event', { ...fields, repeat: 'daily', repeatDays: ['MO'] }, api),
    ).rejects.toThrow(ToolInputError);
    await expect(
      call('cookie_create_event', { ...fields, repeatDays: ['MO'] }, api),
    ).rejects.toThrow(ToolInputError);
    expect(api.calendar.post).not.toHaveBeenCalled();
  });

  test('cookie_update_event with the seriesDate targets the series and sends tone and repeat', async () => {
    const api = fakeApi();
    api.calendar.patch.mockResolvedValue({ event: eventRow });
    const result = await call(
      'cookie_update_event',
      {
        ...fields,
        id: `${SERIES}:2026-10-12`,
        repeat: 'weekly',
        repeatDays: ['MO', 'WE'],
        repeatUntil: '2026-12-31',
        tone: 'accepted',
      },
      api,
    );
    expect(api.calendar.patch).toHaveBeenCalledWith('/calendar-events', {
      id: SERIES,
      title: 'Standup',
      date: '2026-10-05',
      start: '09:30',
      duration: 15,
      calendar: CAL,
      repeat: 'weekly',
      repeatUntil: '2026-12-31',
      repeatDays: ['MO', 'WE'],
      tone: 'accepted',
    });
    expect(result).toEqual({ event: eventRow });
  });

  test('cookie_update_event refuses an occurrence id paired with its own occurrence date', async () => {
    const api = fakeApi();
    const run = call(
      'cookie_update_event',
      { ...fields, id: `${SERIES}:2026-10-12`, date: '2026-10-12', repeat: 'weekly', tone: null },
      api,
    );
    await expect(run).rejects.toThrow(ToolInputError);
    await expect(run).rejects.toThrow(
      'For a recurring event, pass its seriesDate as date; editing changes the whole series',
    );
    expect(api.calendar.patch).not.toHaveBeenCalled();
  });

  test('cookie_update_event requires repeat and tone, while create defaults repeat to none', () => {
    const update = byName(tools, 'cookie_update_event').inputSchema;
    expect(update.safeParse({ ...fields, id: SERIES, tone: null }).success).toBe(false);
    expect(update.safeParse({ ...fields, id: SERIES, repeat: 'none' }).success).toBe(false);
    expect(update.safeParse({ ...fields, id: SERIES, repeat: 'none', tone: null }).success).toBe(
      true,
    );
    expect(byName(tools, 'cookie_create_event').inputSchema.parse(fields).repeat).toBe('none');
  });

  test('cookie_update_event accepts a listed event resent as it was read', async () => {
    const api = fakeApi();
    api.calendar.get.mockResolvedValue({ events: [eventRow], truncated: false });
    const [listed] = (
      await call('cookie_list_events', { from: '2026-10-01', to: '2026-10-31' }, api)
    ).events;
    api.calendar.patch.mockResolvedValue({ event: eventRow });
    await call(
      'cookie_update_event',
      {
        id: listed.id,
        title: listed.title,
        date: listed.date,
        start: listed.start,
        durationMinutes: listed.durationMinutes,
        calendar: listed.calendar,
        repeat: listed.repeat,
        // Both are null for a non-repeating event, and tone is null when unset.
        repeatUntil: listed.repeatUntil,
        repeatDays: listed.repeatDays,
        tone: listed.tone,
      },
      api,
    );
    expect(api.calendar.patch).toHaveBeenCalledWith('/calendar-events', {
      id: SERIES,
      title: 'Standup',
      date: '2026-10-05',
      start: '09:30',
      duration: 15,
      calendar: CAL,
      repeat: 'none',
      tone: null,
    });
  });

  test('cookie_list_events returns 50 events by default and flags the rest', async () => {
    const api = fakeApi();
    api.calendar.get.mockResolvedValue({
      events: Array.from({ length: 51 }, () => eventRow),
      truncated: false,
    });
    const result = await call('cookie_list_events', { from: '2026-10-01', to: '2026-10-31' }, api);
    expect(result.events).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  test('cookie_update_event and cookie_delete_event reject non-UUID ids', async () => {
    const api = fakeApi();
    await expect(
      call('cookie_update_event', { ...fields, id: 'abc', repeat: 'none', tone: null }, api),
    ).rejects.toThrow(ToolInputError);
    await expect(call('cookie_delete_event', { id: 'abc:2026-10-01' }, api)).rejects.toThrow(
      ToolInputError,
    );
    expect(api.calendar.patch).not.toHaveBeenCalled();
    expect(api.calendar.delete).not.toHaveBeenCalled();
  });

  test('cookie_list_calendars marks Google calendars the account can only read', async () => {
    const api = fakeApi();
    api.calendar.get.mockResolvedValue({
      calendars: [
        {
          id: 'google:me@example.com',
          name: 'me@example.com',
          color: '#9fe1e7',
          source: 'google',
          readOnly: false,
        },
        {
          id: 'google:team@group',
          name: 'Team',
          color: '#f6bf26',
          source: 'google',
          readOnly: true,
        },
      ],
    });
    const result = await call('cookie_list_calendars', {}, api);
    expect(result.calendars.map((c) => [c.id, c.readOnly])).toEqual([
      ['google:me@example.com', false],
      ['google:team@group', true],
    ]);
  });

  test('cookie_list_events passes the time zone through for Google events', async () => {
    const api = fakeApi();
    api.calendar.get.mockResolvedValue({ events: [], truncated: false });
    await call(
      'cookie_list_events',
      { from: '2026-10-01', to: '2026-10-31', timeZone: 'Europe/London' },
      api,
    );
    expect(api.calendar.get).toHaveBeenCalledWith('/calendar-events', {
      from: '2026-10-01',
      to: '2026-10-31',
      timeZone: 'Europe/London',
    });
  });

  test('Google events are written with their id and zone, and refused without a zone or with a repeat', async () => {
    const api = fakeApi();
    const google = { ...fields, calendar: 'google:me@example.com' };
    await expect(call('cookie_create_event', google, api)).rejects.toThrow(/timeZone/);
    await expect(
      call('cookie_create_event', { ...google, timeZone: 'Europe/London', repeat: 'weekly' }, api),
    ).rejects.toThrow(/repeat/);
    expect(api.calendar.post).not.toHaveBeenCalled();

    api.calendar.post.mockResolvedValue({ event: { id: 'google:me@example.com:new' } });
    await call('cookie_create_event', { ...google, timeZone: 'Europe/London' }, api);
    expect(api.calendar.post).toHaveBeenCalledWith(
      '/calendar-events',
      expect.objectContaining({ calendar: 'google:me@example.com', timeZone: 'Europe/London' }),
    );

    api.calendar.patch.mockResolvedValue({ event: { id: 'google:me@example.com:evt' } });
    await call(
      'cookie_update_event',
      {
        ...google,
        id: 'google:me@example.com:evt@2026-10-06',
        timeZone: 'UTC',
        repeat: 'none',
        tone: null,
      },
      api,
    );
    expect(api.calendar.patch).toHaveBeenCalledWith(
      '/calendar-events',
      expect.objectContaining({ id: 'google:me@example.com:evt', timeZone: 'UTC' }),
    );

    api.calendar.delete.mockResolvedValue({ ok: true });
    const deleted = await call(
      'cookie_delete_event',
      { id: 'google:me@example.com:evt@2026-10-06' },
      api,
    );
    expect(api.calendar.delete).toHaveBeenCalledWith('/calendar-events', {
      id: 'google:me@example.com:evt',
    });
    expect(deleted.id).toBe('google:me@example.com:evt');
  });

  test('cookie_delete_event deletes the whole series for an occurrence id', async () => {
    const api = fakeApi();
    api.calendar.delete.mockResolvedValue({ ok: true });
    const result = await call('cookie_delete_event', { id: `${SERIES}:2026-10-12` }, api);
    expect(api.calendar.delete).toHaveBeenCalledWith('/calendar-events', { id: SERIES });
    expect(result).toEqual({ deleted: true, id: SERIES });
  });

  test('descriptions state local time, full replace and series scope', () => {
    expect(byName(tools, 'cookie_create_event').description).toMatch(/local/i);
    expect(byName(tools, 'cookie_update_event').description).toMatch(/cookie_list_events/);
    expect(byName(tools, 'cookie_update_event').description).toContain(
      'for a recurring event, pass the seriesDate from cookie_list_events as date (the series start), not the occurrence date',
    );
    expect(byName(tools, 'cookie_delete_event').description).toMatch(/series/i);
  });
});
