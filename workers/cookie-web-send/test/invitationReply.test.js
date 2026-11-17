import { describe, expect, it, vi } from 'vitest';
import { DeliveryError } from '../src/deliveryLedger.js';
import {
  buildReplyCalendar,
  buildReplyMail,
  handleInvitationReply,
} from '../src/invitationReply.js';
import { createMockSql } from './helpers.js';

const USER = '11111111-1111-4111-8111-111111111111';
const INVITATION = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-17T12:00:00.000Z');
const QUOTA = [{ authorized: true, quota_claimed: true }];
const CALENDAR = [{ calendar: 'calendar-1', on_calendar: false, series_on_calendar: false }];
const EVENT = { id: 'event-1', date: '2026-12-01' };

/** @param {Record<string, unknown>} [overrides] */
function invitation(overrides = {}) {
  return {
    id: INVITATION,
    user_id: USER,
    uid: 'team-sync@calendar.example',
    recurrence_id: '',
    sequence: 2,
    status: 'active',
    organizer_address: 'olive@example.com',
    organizer_name: 'Olive Organiser',
    attendee_address: 'me@cookie.test',
    attendee_name: 'Alex Guest',
    title: 'Team sync',
    description: null,
    location: null,
    start_at: '2026-12-01T10:00:00.000Z',
    end_at: '2026-12-01T11:00:00.000Z',
    all_day: false,
    recurrence_rule: null,
    time_zone: 'Europe/London',
    response: null,
    responded_at: null,
    reply_revision: 0,
    message_id: MESSAGE,
    ...overrides,
  };
}

/** @param {unknown} body @param {string} [method] */
function request(body, method = 'POST') {
  return new Request('https://send-api.example/send/invitation-reply', {
    method,
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

const answer = (response = 'accepted') => ({
  invitationId: INVITATION,
  response,
  timeZone: 'Europe/London',
});

function services() {
  return /** @type {any} */ ({
    env: { EMAIL_FROM: 'Cookie <me@cookie.test>', RESEND_API_KEY: 'test-key' },
    indexSentMessage: vi.fn(),
  });
}

/**
 * A stand-in for deliverMail that records what it was asked to send.
 * @param {any} [result]
 * @returns {any}
 */
function delivery(result = { resendId: 'provider-1', messageUuid: 'sent-1', inserted: true }) {
  return vi.fn(async (..._args) => result);
}

/** @param {string} text */
const lines = (text) => text.split('\r\n');

describe('buildReplyCalendar', () => {
  it('answers the revision it was sent, as one guest', () => {
    const text = buildReplyCalendar(invitation(), 'accepted', NOW);
    expect(lines(text)).toEqual([
      'BEGIN:VCALENDAR',
      'PRODID:-//Cookie//Cookie Mail//EN',
      'VERSION:2.0',
      'METHOD:REPLY',
      'BEGIN:VEVENT',
      'UID:team-sync@calendar.example',
      'DTSTAMP:20261117T120000Z',
      'DTSTART:20261201T100000Z',
      'DTEND:20261201T110000Z',
      'SEQUENCE:2',
      'ORGANIZER;CN="Olive Organiser":mailto:olive@example.com',
      'ATTENDEE;PARTSTAT=ACCEPTED;CN="Alex Guest":mailto:me@cookie.test',
      'SUMMARY:Team sync',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ]);
  });

  it.each([
    ['tentative', 'TENTATIVE'],
    ['declined', 'DECLINED'],
  ])('writes a %s answer as PARTSTAT=%s', (response, partstat) => {
    const text = buildReplyCalendar(
      invitation({ attendee_name: null }),
      /** @type {any} */ (response),
      NOW,
    );
    expect(text).toContain(`ATTENDEE;PARTSTAT=${partstat}:mailto:me@cookie.test`);
  });

  it('names the occurrence it answers', () => {
    const timed = buildReplyCalendar(
      invitation({ recurrence_id: '20261208T100000Z' }),
      'accepted',
      NOW,
    );
    expect(timed).toContain('\r\nRECURRENCE-ID:20261208T100000Z\r\n');
    const allDay = buildReplyCalendar(
      invitation({
        recurrence_id: '20261223',
        all_day: true,
        start_at: '2026-12-24T00:00:00.000Z',
        end_at: '2026-12-26T00:00:00.000Z',
      }),
      'accepted',
      NOW,
    );
    expect(allDay).toContain('\r\nRECURRENCE-ID;VALUE=DATE:20261223\r\n');
    expect(allDay).toContain('\r\nDTSTART;VALUE=DATE:20261224\r\n');
    expect(allDay).toContain('\r\nDTEND;VALUE=DATE:20261226\r\n');
  });

  it('escapes text, strips what a parameter cannot hold, and folds long lines', () => {
    const text = buildReplyCalendar(
      invitation({
        uid: 'a,b;c\\d',
        organizer_name: 'Olive "The Boss"\r\nATTENDEE:mailto:evil@example.com',
        title: `Planning; budget, hiring\nand ${'a very long agenda '.repeat(6)}café`,
      }),
      'accepted',
      NOW,
    );
    expect(text).toContain('UID:a\\,b\\;c\\\\d');
    expect(text).toContain(
      'ORGANIZER;CN="Olive The BossATTENDEE:mailto:evil@example.com":mailto:olive@',
    );
    expect(text).toContain('SUMMARY:Planning\\; budget\\, hiring\\nand');
    // The injected line stayed inside the organiser's name: one guest only.
    expect(lines(text).filter((line) => line.startsWith('ATTENDEE'))).toHaveLength(1);
    for (const line of lines(text)) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    const unfolded = text.replace(/\r\n /g, '');
    expect(unfolded).toContain('café');
  });
});

describe('buildReplyMail', () => {
  it('carries the calendar as a reply part and says the answer in words', () => {
    const mail = buildReplyMail(invitation(), 'tentative', NOW);
    expect(mail.subject).toBe('Tentatively accepted: Team sync');
    expect(mail.text).toBe(
      'Alex Guest has tentatively accepted this invitation.\n\nTeam sync\nTuesday, 1 December 2026 at 10:00 GMT\n',
    );
    expect(mail.attachment).toMatchObject({
      filename: 'invite.ics',
      contentType: 'text/calendar; charset=utf-8; method=REPLY',
    });
    expect(atob(mail.attachment.content)).toBe(buildReplyCalendar(invitation(), 'tentative', NOW));
  });

  it('keeps a subject on one line and falls back to the address for a nameless guest', () => {
    const mail = buildReplyMail(
      invitation({ title: 'Review\r\nBcc: someone@example.com', attendee_name: null }),
      'declined',
      NOW,
    );
    expect(mail.subject).toBe('Declined: Review Bcc: someone@example.com');
    expect(mail.text).toContain('me@cookie.test has declined this invitation.');
  });

  it('gives an all-day event its date only, and an unknown zone UTC', () => {
    const allDay = buildReplyMail(
      invitation({
        all_day: true,
        start_at: '2026-12-24T00:00:00.000Z',
        end_at: '2026-12-25T00:00:00.000Z',
      }),
      'accepted',
      NOW,
    );
    expect(allDay.text).toContain('Thursday, 24 December 2026\n');
    expect(
      buildReplyMail(invitation({ time_zone: 'Custom/Zone' }), 'accepted', NOW).text,
    ).toContain('10:00 UTC');
  });
});

describe('POST /send/invitation-reply', () => {
  it('accepts POST only', async () => {
    const sql = createMockSql();
    const response = await handleInvitationReply(sql, USER, request(null, 'GET'), services());
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(sql.calls).toHaveLength(0);
  });

  it.each([
    [{ ...answer(), invitationId: 'not-an-id' }],
    [{ ...answer(), response: 'maybe' }],
    [{ ...answer(), timeZone: 'Mars/Olympus' }],
    [{ invitationId: INVITATION, response: 'accepted' }],
  ])('rejects an invalid request before any database access: %j', async (body) => {
    const sql = createMockSql();
    const deliver = delivery();
    const response = await handleInvitationReply(sql, USER, request(body), services(), { deliver });
    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('returns 404 for an invitation that is not the caller’s', async () => {
    const sql = createMockSql([[]]);
    const response = await handleInvitationReply(sql, USER, request(answer()), services());
    expect(response.status).toBe(404);
    expect(sql.calls[0].values).toEqual([INVITATION, USER]);
  });

  it.each([
    [{ status: 'cancelled' }, 409, 'INVITATION_CANCELLED'],
    [{ attendee_address: 'alex@personal.example' }, 403, 'INVITATION_ALIAS'],
    [{ attendee_address: null }, 403, 'INVITATION_NOT_INVITED'],
  ])('refuses %j without sending', async (overrides, status, code) => {
    const sql = createMockSql([[invitation(overrides)]]);
    const deliver = delivery();
    const response = await handleInvitationReply(sql, USER, request(answer()), services(), {
      deliver,
    });
    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(code);
    expect(deliver).not.toHaveBeenCalled();
    expect(sql.calls).toHaveLength(1);
  });

  it('refuses when this deployment has no sending address', async () => {
    const sql = createMockSql([[invitation()]]);
    const response = await handleInvitationReply(sql, USER, request(answer()), {
      ...services(),
      env: {},
    });
    expect(response.status).toBe(503);
  });

  it('refuses an invitation whose organiser cannot be mailed', async () => {
    const sql = createMockSql([[invitation({ organizer_address: 'not an address' })]]);
    const response = await handleInvitationReply(sql, USER, request(answer()), services());
    expect(response.status).toBe(422);
  });

  it('sends the reply once, then records the answer and the calendar entry', async () => {
    const stored = invitation();
    const recorded = {
      ...stored,
      response: 'accepted',
      responded_at: NOW.toISOString(),
      reply_revision: 1,
    };
    const sql = createMockSql([[stored], QUOTA, [recorded], CALENDAR, [], [EVENT]]);
    const deliver = delivery();
    const svc = services();

    const response = await handleInvitationReply(sql, USER, request(answer()), svc, {
      deliver,
      now: () => NOW,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      invitation: {
        id: INVITATION,
        response: 'accepted',
        responded_at: NOW.toISOString(),
        event: EVENT,
      },
      sent: true,
    });
    expect(deliver).toHaveBeenCalledOnce();
    const [, userId, mail] = deliver.mock.calls[0];
    expect(userId).toBe(USER);
    expect(mail).toMatchObject({
      recipients: ['olive@example.com'],
      subject: 'Accepted: Team sync',
      html: null,
      replyToMessageId: MESSAGE,
      idempotencyKey: `invitation-reply/${INVITATION}/2/0/accepted`,
    });
    expect(mail.inlineAttachments).toHaveLength(1);
    expect(svc.indexSentMessage).toHaveBeenCalledWith('sent-1');
    // Recorded against the revision and answer count the reply was built from.
    expect(sql.calls[2].text).toContain('UPDATE calendar_invitations SET');
    expect(sql.calls[2].values).toEqual(
      expect.arrayContaining([
        'accepted',
        NOW.toISOString(),
        'Europe/London',
        INVITATION,
        USER,
        2,
        0,
      ]),
    );
    expect(sql.calls[5].values).toContain('accepted');
  });

  it('names each answer by how many came before, so a change of mind is a new reply', async () => {
    const stored = invitation({
      response: 'accepted',
      responded_at: '2026-11-17T11:00:00.000Z',
      reply_revision: 3,
    });
    const recorded = {
      ...stored,
      response: 'declined',
      responded_at: NOW.toISOString(),
      reply_revision: 4,
    };
    const sql = createMockSql([[stored], QUOTA, [recorded], []]);
    const deliver = delivery();

    const response = await handleInvitationReply(
      sql,
      USER,
      request(answer('declined')),
      services(),
      {
        deliver,
        now: () => NOW,
      },
    );

    expect((await response.json()).invitation).toMatchObject({ response: 'declined', event: null });
    expect(deliver.mock.calls[0][2].idempotencyKey).toBe(
      `invitation-reply/${INVITATION}/2/3/declined`,
    );
    // A declined event comes off the calendar.
    expect(sql.calls[3].text).toContain('DELETE FROM calendar_events');
  });

  it('sends nothing for an answer already given, and puts the event back', async () => {
    const stored = invitation({
      response: 'tentative',
      responded_at: '2026-11-17T11:00:00.000Z',
      reply_revision: 1,
    });
    const sql = createMockSql([[stored], [stored], CALENDAR, [], [EVENT]]);
    const deliver = delivery();

    const response = await handleInvitationReply(
      sql,
      USER,
      request(answer('tentative')),
      services(),
      { deliver },
    );

    expect(await response.json()).toMatchObject({
      sent: false,
      invitation: { response: 'tentative', event: EVENT },
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(sql.calls.some(({ text }) => text.includes('outbound_email_quotas'))).toBe(false);
    // The invitation row is locked before its calendar entries are replaced.
    expect(sql.calls[1].text).toContain('FOR UPDATE');
    expect(sql.calls[4].values).toContain('suggested');
  });

  it('does not re-file an event whose invitation changed under a repeated answer', async () => {
    const stored = invitation({ response: 'accepted', reply_revision: 1 });
    const sql = createMockSql([[stored], [{ ...stored, status: 'cancelled' }]]);
    const deliver = delivery();

    const response = await handleInvitationReply(sql, USER, request(answer()), services(), {
      deliver,
    });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('INVITATION_CHANGED');
    expect(deliver).not.toHaveBeenCalled();
    expect(sql.calls).toHaveLength(2);
  });

  it.each([
    [{ authorized: false, quota_claimed: false }, 403],
    [{ authorized: true, quota_claimed: false }, 429],
  ])('stops at the sending allowance: %j', async (quota, status) => {
    const sql = createMockSql([[invitation()], [quota]]);
    const deliver = delivery();
    const response = await handleInvitationReply(sql, USER, request(answer()), services(), {
      deliver,
    });
    expect(response.status).toBe(status);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('reports sending as unavailable when the allowance cannot be checked', async () => {
    const sql = createMockSql([[invitation()]]);
    sql
      .mockImplementationOnce(async () => [invitation()])
      .mockImplementationOnce(async () => {
        throw new Error('database unavailable');
      });
    const response = await handleInvitationReply(sql, USER, request(answer()), services(), {
      deliver: delivery(),
    });
    expect(response.status).toBe(503);
  });

  it('asks for a retry while a delivery is unconfirmed, leaving the answer unrecorded', async () => {
    const sql = createMockSql([[invitation()], QUOTA]);
    const deliver = vi.fn(async () => {
      throw new DeliveryError('DELIVERY_PENDING');
    });
    const response = await handleInvitationReply(sql, USER, request(answer()), services(), {
      deliver,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect((await response.json()).code).toBe('DELIVERY_PENDING');
    // The allowance is given back; the invitation is untouched.
    expect(sql.calls[2].text).toContain('UPDATE outbound_email_quotas');
    expect(sql.calls.some(({ text }) => text.includes('UPDATE calendar_invitations'))).toBe(false);
  });

  it.each(['DELIVERY_REJECTED', 'DELIVERY_UNCERTAIN'])(
    'frees the invitation for a fresh answer after %s',
    async (code) => {
      const sql = createMockSql([[invitation()], QUOTA]);
      const deliver = vi.fn(async () => {
        throw new DeliveryError(code);
      });
      const response = await handleInvitationReply(sql, USER, request(answer()), services(), {
        deliver,
      });

      expect(response.status).toBe(502);
      expect((await response.json()).code).toBe(code);
      expect(sql.calls[3].text).toContain('reply_revision = reply_revision + 1');
      expect(sql.calls[3].text).not.toContain('response =');
    },
  );

  it('lets an unexpected delivery failure surface after giving the allowance back', async () => {
    const sql = createMockSql([[invitation()], QUOTA]);
    const deliver = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(
      handleInvitationReply(sql, USER, request(answer()), services(), { deliver }),
    ).rejects.toThrow('boom');
    expect(sql.calls[2].text).toContain('UPDATE outbound_email_quotas');
  });

  it('gives the allowance back when the delivery had already gone out', async () => {
    const stored = invitation();
    const recorded = {
      ...stored,
      response: 'accepted',
      responded_at: NOW.toISOString(),
      reply_revision: 1,
    };
    const sql = createMockSql([[stored], QUOTA, [], [recorded], CALENDAR, [], [EVENT]]);
    const svc = services();
    const response = await handleInvitationReply(sql, USER, request(answer()), svc, {
      deliver: delivery({ resendId: 'provider-1', messageUuid: 'sent-1', inserted: false }),
      now: () => NOW,
    });
    expect((await response.json()).sent).toBe(true);
    expect(sql.calls[2].text).toContain('UPDATE outbound_email_quotas');
    expect(svc.indexSentMessage).not.toHaveBeenCalled();
  });

  it('reports the answer that stands when a later one was recorded meanwhile', async () => {
    const latest = invitation({
      response: 'declined',
      responded_at: '2026-11-17T12:00:05.000Z',
      reply_revision: 2,
    });
    const sql = createMockSql([[invitation()], QUOTA, [], [latest], []]);
    const response = await handleInvitationReply(sql, USER, request(answer()), services(), {
      deliver: delivery(),
      now: () => NOW,
    });
    expect(await response.json()).toMatchObject({
      sent: true,
      invitation: { response: 'declined', event: null },
    });
  });

  it('says so when the organiser changed the event while the reply was in flight', async () => {
    const revised = invitation({ sequence: 3, response: null });
    const sql = createMockSql([[invitation()], QUOTA, [], [revised]]);
    const response = await handleInvitationReply(sql, USER, request(answer()), services(), {
      deliver: delivery(),
      now: () => NOW,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('INVITATION_CHANGED');
  });
});
