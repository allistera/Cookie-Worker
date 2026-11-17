import { describe, expect, test } from 'vitest';
import { compareRevision, invitationView, syncInvitation } from '../src/invitations.js';
import { createMockSql } from './helpers.js';

const USER = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const SENDER = 'me@cookie.test';
const message = {
  id: MESSAGE,
  userId: USER,
  ownerEmail: 'Alex@Personal.example',
  envelopeTo: SENDER,
};

/** @param {Record<string, unknown>} [overrides] */
function parsed(overrides = {}) {
  return /** @type {any} */ ({
    method: 'request',
    uid: 'team-sync@calendar.example',
    recurrenceId: '',
    sequence: 1,
    dtstamp: '2026-11-17T09:00:00.000Z',
    organizer: { address: 'olive@example.com', name: 'Olive Organiser' },
    attendees: [
      { address: 'alex@personal.example', name: 'Alex' },
      { address: SENDER, name: 'Alex Guest' },
    ],
    title: 'Team sync',
    description: null,
    location: null,
    startAt: '2026-12-01T10:00:00.000Z',
    endAt: '2026-12-01T11:00:00.000Z',
    allDay: false,
    recurrenceRule: null,
    timeZone: 'Europe/London',
    ...overrides,
  });
}

/** @param {Record<string, unknown>} [overrides] */
function stored(overrides = {}) {
  return {
    id: 'invitation-1',
    user_id: USER,
    uid: 'team-sync@calendar.example',
    recurrence_id: '',
    sequence: 1,
    dtstamp: new Date('2026-11-17T09:00:00.000Z'),
    status: 'active',
    organizer_address: 'olive@example.com',
    organizer_name: 'Olive Organiser',
    attendee_address: SENDER,
    attendee_name: 'Alex Guest',
    title: 'Team sync',
    location: null,
    start_at: new Date('2026-12-01T10:00:00.000Z'),
    end_at: new Date('2026-12-01T11:00:00.000Z'),
    all_day: false,
    recurrence_rule: null,
    response: 'accepted',
    responded_at: new Date('2026-11-17T10:00:00.000Z'),
    event_time_zone: 'Europe/London',
    message_id: MESSAGE,
    ...overrides,
  };
}

describe('compareRevision', () => {
  test('orders revisions by sequence first', () => {
    expect(compareRevision(parsed({ sequence: 2 }), stored())).toBe('newer');
    expect(
      compareRevision(parsed({ sequence: 0, dtstamp: '2027-01-01T00:00:00.000Z' }), stored()),
    ).toBe('older');
  });

  test('orders one sequence by when the organiser sent it', () => {
    expect(compareRevision(parsed({ dtstamp: '2026-11-17T09:00:01.000Z' }), stored())).toBe(
      'newer',
    );
    expect(compareRevision(parsed({ dtstamp: '2026-11-17T08:59:59.000Z' }), stored())).toBe(
      'older',
    );
    expect(compareRevision(parsed(), stored())).toBe('same');
  });

  test('treats a missing timestamp on either side as the same revision', () => {
    expect(compareRevision(parsed({ dtstamp: null }), stored())).toBe('same');
    expect(compareRevision(parsed(), stored({ dtstamp: null }))).toBe('same');
  });
});

describe('syncInvitation', () => {
  test('creates the invitation for the address Cookie sends from', async () => {
    const created = stored({ response: null });
    const sql = createMockSql([[created]]);
    const result = await syncInvitation(sql, message, parsed(), SENDER);

    expect(result).toEqual({ invitation: created, current: true, event: null });
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain('ON CONFLICT (user_id, uid, recurrence_id) DO NOTHING');
    // Both of the person's addresses are guests; the sending one is preferred.
    expect(sql.calls[0].values).toEqual(expect.arrayContaining([SENDER, 'Alex Guest', 'active']));
    expect(sql.calls[0].values).not.toContain('alex@personal.example');
  });

  test.each([
    [
      'their account address',
      [{ address: 'alex@personal.example', name: 'Alex' }],
      'alex@personal.example',
    ],
    ['no guest of theirs', [{ address: 'someone@else.example', name: null }], null],
  ])(
    'records %s as the guest when the sending address is not invited',
    async (_label, attendees, expected) => {
      const sql = createMockSql([[stored()]]);
      await syncInvitation(sql, message, parsed({ attendees }), SENDER);
      // attendee_address is the ninth column of the insert.
      expect(sql.calls[0].values[8]).toBe(expected);
    },
  );

  test('does not track an event the person organised', async () => {
    const sql = createMockSql();
    const own = parsed({ organizer: { address: 'alex@personal.example', name: null } });
    expect(await syncInvitation(sql, message, own, SENDER)).toBeNull();
    expect(sql.calls).toHaveLength(0);
  });

  test('leaves a stored invitation alone when the same revision is read again', async () => {
    const row = stored();
    const sql = createMockSql([[], [row], [{ id: 'event-1', date: '2026-12-01' }]]);
    const result = await syncInvitation(sql, message, parsed(), SENDER);

    expect(result).toEqual({
      invitation: row,
      current: true,
      event: { id: 'event-1', date: '2026-12-01' },
    });
    expect(sql.calls[1].text).toContain('FOR UPDATE');
    expect(sql.calls.some(({ text }) => text.includes('UPDATE calendar_invitations'))).toBe(false);
  });

  test('reports an older revision as not current and changes nothing', async () => {
    const row = stored({ sequence: 3 });
    const sql = createMockSql([[], [row], []]);
    const result = await syncInvitation(sql, message, parsed({ title: 'Old title' }), SENDER);

    expect(result).toEqual({ invitation: row, current: false, event: null });
    expect(sql.calls).toHaveLength(3);
  });

  test('applies a newer revision, clears the answer and moves the calendar entry', async () => {
    const updated = stored({ sequence: 2, response: null, responded_at: null });
    const sql = createMockSql([
      [],
      [stored()],
      [updated],
      [{ calendar: 'calendar-1', on_calendar: true, series_on_calendar: false }],
      [],
      [{ id: 'event-2', date: '2026-12-03' }],
      [{ id: 'event-2', date: '2026-12-03' }],
    ]);
    const revision = parsed({
      sequence: 2,
      startAt: '2026-12-03T15:30:00.000Z',
      endAt: '2026-12-03T16:30:00.000Z',
    });
    const result = await syncInvitation(sql, message, revision, SENDER);

    expect(result).toMatchObject({ current: true, event: { id: 'event-2', date: '2026-12-03' } });
    const update = sql.calls[2];
    expect(update.text).toContain('UPDATE calendar_invitations SET');
    // response and responded_at are cleared by the new sequence.
    expect(update.values.filter((value) => value === null).length).toBeGreaterThanOrEqual(2);
    expect(update.values).not.toContain('accepted');
    expect(sql.calls[5].text).toContain('INSERT INTO calendar_events');
    expect(sql.calls[5].values).toContain('suggested');
  });

  test('keeps the answer when only the details changed', async () => {
    const sql = createMockSql([[], [stored()], [stored({ title: 'Agenda attached' })], [], []]);
    await syncInvitation(
      sql,
      message,
      parsed({ dtstamp: '2026-11-18T09:00:00.000Z', title: 'Agenda attached' }),
      SENDER,
    );
    expect(sql.calls[2].values).toContain('accepted');
  });

  test('does not touch the calendar for an invitation that was never added to it', async () => {
    const never = stored({ response: null, event_time_zone: null });
    const sql = createMockSql([[], [never], [stored({ sequence: 2, event_time_zone: null })], []]);
    await syncInvitation(sql, message, parsed({ sequence: 2 }), SENDER);
    expect(sql.calls.some(({ text }) => text.includes('calendar_events ce'))).toBe(false);
    expect(sql.calls).toHaveLength(4);
  });

  test.each([
    ['at the sequence it withdraws', 1],
    ['at a later sequence', 2],
  ])('applies a cancellation %s and removes the calendar entry', async (_label, sequence) => {
    const cancelled = stored({ status: 'cancelled', sequence });
    const sql = createMockSql([[], [stored()], [cancelled], [], []]);
    const result = await syncInvitation(
      sql,
      message,
      parsed({ method: 'cancel', sequence }),
      SENDER,
    );

    expect(result).toEqual({ invitation: cancelled, current: true, event: null });
    expect(sql.calls[2].values).toContain('cancelled');
    expect(sql.calls[3].text).toContain('DELETE FROM calendar_events');
  });

  test('ignores a cancellation older than the stored revision', async () => {
    const row = stored({ sequence: 4 });
    const sql = createMockSql([[], [row], []]);
    const result = await syncInvitation(sql, message, parsed({ method: 'cancel' }), SENDER);
    expect(result).toMatchObject({ invitation: row, current: false });
    expect(sql.calls).toHaveLength(3);
  });

  test('ignores a revision from someone other than the organiser on record', async () => {
    const sql = createMockSql([[], [stored({ organizer_address: 'someone@else.example' })]]);
    expect(
      await syncInvitation(sql, message, parsed({ method: 'cancel', sequence: 9 }), SENDER),
    ).toBeNull();
    expect(sql.calls).toHaveLength(2);
  });

  test('records a cancellation seen first as an invitation already cancelled', async () => {
    const sql = createMockSql([[stored({ status: 'cancelled' })]]);
    await syncInvitation(sql, message, parsed({ method: 'cancel' }), SENDER);
    expect(sql.calls[0].values).toContain('cancelled');
  });
});

describe('invitationView', () => {
  test('describes a series and an occurrence', () => {
    const series = invitationView(
      { invitation: stored({ recurrence_rule: 'FREQ=WEEKLY' }), current: true, event: null },
      SENDER,
    );
    expect(series).toMatchObject({ recurring: true, occurrence: false, can_reply: true });
    const occurrence = invitationView(
      {
        invitation: stored({ recurrence_rule: 'FREQ=WEEKLY', recurrence_id: '20261208T100000Z' }),
        current: true,
        event: null,
      },
      SENDER,
    );
    expect(occurrence).toMatchObject({ recurring: false, occurrence: true });
  });

  test('says why an invitation cannot be answered from here', () => {
    const view = invitationView(
      {
        invitation: stored({ attendee_address: 'alex@personal.example' }),
        current: true,
        event: null,
      },
      SENDER,
    );
    expect(view).toMatchObject({
      attendee: 'alex@personal.example',
      sender: SENDER,
      can_reply: false,
      reply_blocked: 'alias',
      response: 'accepted',
      responded_at: '2026-11-17T10:00:00.000Z',
    });
    expect(
      invitationView({ invitation: stored(), current: true, event: null }, null),
    ).toMatchObject({
      sender: null,
      reply_blocked: 'not_configured',
    });
  });
});
