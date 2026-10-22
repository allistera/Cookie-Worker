import { describe, expect, test, vi } from 'vitest';
import { createEvent, updateEvent, deleteEvent } from '../src/calendarEvents.js';

const id = '11111111-1111-4111-8111-111111111111';
const fields = {
  id,
  title: ' Review ',
  date: '2026-10-21',
  start: '09:00',
  duration: 30,
  calendar: 'work',
};
function database() {
  /** @type {any} */
  const sql = vi.fn();
  return sql;
}
const missing = (code) => Object.assign(new Error('migration pending'), { code });

describe('calendar event writes', () => {
  test('creates an owned event with normalized fields and recurrence', async () => {
    const sql = database()
      .mockResolvedValueOnce([{ id }])
      .mockResolvedValueOnce([{ id, title: 'Review' }]);
    const response = await createEvent(sql, 'owner', {
      ...fields,
      duration: 30.9,
      repeat: 'weekly',
      repeatDays: ['FR', 'MO', 'MO'],
      location: ' Office ',
      description: ' Agenda ',
      tone: 'accepted',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ event: { id, title: 'Review' } });
    expect(sql.mock.calls[1].slice(1)).toEqual([
      'owner',
      'Review',
      'Agenda',
      'Office',
      fields.date,
      fields.start,
      30,
      id,
      'accepted',
      'WEEKLY;BYDAY=MO,FR',
      'owner',
    ]);
  });

  test('updates an event after checking ownership and subscription status', async () => {
    const sql = database()
      .mockResolvedValueOnce([{ id }])
      .mockResolvedValueOnce([{ isSubscribed: false }])
      .mockResolvedValueOnce([{ id, title: 'Review' }]);
    const response = await updateEvent(sql, 'owner', fields);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ event: { id, title: 'Review' } });
    expect(sql.mock.calls[2].slice(1)).toContain('owner');
    expect(sql.mock.calls[2][0].join('')).toContain('WHERE ce.id =');
  });

  test('returns not found if the owner disappears before creation', async () => {
    const sql = database().mockResolvedValueOnce([{ id }]).mockResolvedValueOnce([]);
    const response = await createEvent(sql, 'owner', fields);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'User not found' });
  });

  test('returns not found for an event missing at update time', async () => {
    const sql = database()
      .mockResolvedValueOnce([{ id }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const response = await updateEvent(sql, 'owner', fields);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Event not found' });
  });

  test.each([{ rows: [] }, { rows: [{ id }] }])(
    'retries calendar resolution without subscription columns: %j',
    async ({ rows }) => {
      const sql = database()
        .mockRejectedValueOnce(missing('42703'))
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([{ id }]);
      const response = await createEvent(sql, 'owner', fields);
      expect(response.status).toBe(rows.length ? 201 : 404);
      expect(sql.mock.calls[1][0].join('')).not.toContain('subscription_url');
    },
  );

  test.each(['work', id])(
    'accepts only legacy calendars before the calendars table exists: %s',
    async (calendar) => {
      const sql = database()
        .mockRejectedValueOnce(missing('42P01'))
        .mockResolvedValueOnce([{ id }]);
      const response = await createEvent(sql, 'owner', { ...fields, calendar });
      expect(response.status).toBe(calendar === 'work' ? 201 : 404);
    },
  );

  test('propagates unexpected calendar lookup failures', async () => {
    const error = new Error('connection lost');
    const sql = database().mockRejectedValue(error);
    await expect(createEvent(sql, 'owner', fields)).rejects.toBe(error);
  });

  test('deletes an owned event during the subscription-column migration', async () => {
    const sql = database().mockRejectedValueOnce(missing('42703')).mockResolvedValueOnce([{ id }]);
    const response = await deleteEvent(sql, 'owner', { id });
    expect(await response.json()).toEqual({ ok: true });
    expect(sql.mock.calls[1].slice(1)).toEqual([id, 'owner']);
  });

  test('does not delete after an unexpected subscription-check failure', async () => {
    const error = new Error('connection lost');
    const sql = database().mockRejectedValueOnce(error);
    await expect(deleteEvent(sql, 'owner', { id })).rejects.toBe(error);
    expect(sql).toHaveBeenCalledOnce();
  });

  test('reports missing events on delete', async () => {
    const sql = database().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const response = await deleteEvent(sql, 'owner', { id });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Event not found' });
  });
});
