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

  test('cookie_list_events queries the range, filters by calendar and applies limit', async () => {
    const api = fakeApi();
    const other = { ...eventRow, id: `${SERIES}:2026-10-06`, calendar: 'work', seriesId: SERIES };
    api.calendar.get.mockResolvedValue({
      events: [eventRow, other, { ...other, id: `${SERIES}:2026-10-07` }],
      truncated: false,
    });
    const result = await call(
      'cookie_list_events',
      { from: '2026-10-01', to: '2026-10-31', calendar: 'work', limit: 1 },
      api,
    );
    expect(api.calendar.get).toHaveBeenCalledWith('/calendar-events', {
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(result.events).toEqual([
      {
        id: `${SERIES}:2026-10-06`,
        seriesId: SERIES,
        title: 'Standup',
        date: '2026-10-05',
        start: '09:30',
        durationMinutes: 15,
        calendar: 'work',
        location: null,
        description: null,
        recurrenceRule: null,
        allDay: false,
      },
    ]);
    expect(result.truncated).toBe(true);
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
      event: { ...eventRow, recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO,WE' },
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

  test('cookie_update_event reduces an occurrence id to the series id', async () => {
    const api = fakeApi();
    api.calendar.patch.mockResolvedValue({ event: eventRow });
    const result = await call(
      'cookie_update_event',
      { ...fields, id: `${SERIES}:2026-10-12` },
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
    });
    expect(result).toEqual({ event: eventRow });
  });

  test('cookie_update_event and cookie_delete_event reject non-UUID ids', async () => {
    const api = fakeApi();
    await expect(call('cookie_update_event', { ...fields, id: 'abc' }, api)).rejects.toThrow(
      ToolInputError,
    );
    await expect(call('cookie_delete_event', { id: 'abc:2026-10-01' }, api)).rejects.toThrow(
      ToolInputError,
    );
    expect(api.calendar.patch).not.toHaveBeenCalled();
    expect(api.calendar.delete).not.toHaveBeenCalled();
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
    expect(byName(tools, 'cookie_delete_event').description).toMatch(/series/i);
  });
});
