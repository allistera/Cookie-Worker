// The invitation flow end to end on PostgreSQL: cookie-web-messages records
// each revision a mail carries, cookie-web-send answers the organiser through
// the real delivery ledger, and both keep the calendar in step. Only the mail
// provider is a stand-in.
import process from 'node:process';
import ical from 'node-ical';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseCalendarInvitation } from '../../cookie-web-messages/src/calendarInvite.js';
import { invitationView, syncInvitation } from '../../cookie-web-messages/src/invitations.js';
import { handleInvitationReply } from '../src/invitationReply.js';

const databaseUrl = process.env.SCREENING_RETENTION_TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) {
  throw new Error('CI requires the disposable invitation database');
}
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/cookie_screening_retention_test' ||
    url.search ||
    url.hash
  )
    throw new Error('Invitation tests require the isolated loopback test database');
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const CALENDAR = '22222222-2222-4222-8222-222222222222';
const SENDER = 'me@cookie.test';
const ORGANISER = 'olive@example.com';
const EMAIL_FROM = `Cookie <${SENDER}>`;
const SCHEMA = 'calendar_invitation_fixture';

/**
 * An invitation as Google Calendar writes it, trimmed to what matters here.
 * @param {{method?: string, uid?: string, sequence?: number, dtstamp?: string, start?: string, end?: string, attendee?: string, extra?: string[], title?: string}} [options]
 */
function invitationIcs({
  method = 'REQUEST',
  uid = 'team-sync@calendar.example',
  sequence = 0,
  dtstamp = '20261117T090000Z',
  start = 'DTSTART;TZID=Europe/London:20261201T100000',
  end = 'DTEND;TZID=Europe/London:20261201T110000',
  attendee = SENDER,
  extra = [],
  title = 'Team sync',
} = {}) {
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Example//Calendar//EN',
    'VERSION:2.0',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    start,
    end,
    `SEQUENCE:${sequence}`,
    `ORGANIZER;CN=Olive Organiser:mailto:${ORGANISER}`,
    `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Alex Guest:mailto:${attendee}`,
    `ATTENDEE;PARTSTAT=ACCEPTED;CN=Olive Organiser:mailto:${ORGANISER}`,
    `SUMMARY:${title}`,
    ...(method === 'CANCEL' ? ['STATUS:CANCELLED'] : []),
    ...extra,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

describe.skipIf(!databaseUrl)('calendar invitations on PostgreSQL', () => {
  /** @type {import('postgres').Sql} */
  let sql;
  let providerCalls = 0;

  beforeAll(async () => {
    sql = postgres(/** @type {string} */ (databaseUrl), {
      max: 1,
      connection: { search_path: SCHEMA, statement_timeout: 10000 },
      onnotice: () => {},
    });
    // The tables the two handlers touch. calendar_invitations and the
    // calendar_events link follow migration 0113.
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE users(id uuid PRIMARY KEY, email text, prefs jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE threads(id uuid PRIMARY KEY, user_id uuid, subject text, last_message_at timestamptz, message_count int DEFAULT 1);
      CREATE TABLE messages(id uuid PRIMARY KEY, thread_id uuid, user_id uuid, from_name text, from_address text,
        recipients jsonb, subject text, snippet text, body_text text, body_html text, sent_at timestamptz,
        message_id text, headers jsonb, envelope_to text, is_unread boolean, is_sent boolean DEFAULT false,
        is_deleted boolean NOT NULL DEFAULT false, follow_up_at timestamptz);
      CREATE UNIQUE INDEX message_provider_id ON messages(user_id, message_id) WHERE message_id IS NOT NULL;
      CREATE TABLE attachments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message_id uuid, filename text, content_type text, size_bytes bigint, blob_url text);
      CREATE TABLE message_read_receipts(message_id uuid PRIMARY KEY, user_id uuid, token uuid);
      CREATE TABLE outbound_attachments(id uuid PRIMARY KEY, user_id uuid, blob_url text);
      CREATE TABLE scheduled_sends(id uuid PRIMARY KEY, user_id uuid, status text, sent_message_id uuid, sent_at timestamptz, claimed_at timestamptz, last_error text);
      CREATE TABLE outbound_email_quotas(user_id uuid PRIMARY KEY, window_start timestamptz NOT NULL, send_count smallint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE outbound_deliveries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE CASCADE,
        source_key text NOT NULL, request_id text, provider_payload jsonb NOT NULL, copy_payload jsonb NOT NULL, status text DEFAULT 'pending',
        attempts int DEFAULT 0, first_attempt_at timestamptz, retry_until timestamptz, claimed_at timestamptz, claim_token uuid,
        provider_id text, accepted_at timestamptz, sent_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
        last_error text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE(user_id, source_key));
      CREATE UNIQUE INDEX delivery_request ON outbound_deliveries(user_id, request_id) WHERE request_id IS NOT NULL;
      CREATE TABLE outbound_delivery_uploads(delivery_id uuid REFERENCES outbound_deliveries(id) ON DELETE CASCADE,
        outbound_attachment_id uuid REFERENCES outbound_attachments(id), PRIMARY KEY(delivery_id, outbound_attachment_id));
      CREATE TABLE calendars(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, name text NOT NULL,
        color text NOT NULL DEFAULT '#2db985', subscription_url text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE calendar_invitations(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        uid text NOT NULL CHECK (length(uid) BETWEEN 1 AND 500),
        recurrence_id text NOT NULL DEFAULT '' CHECK (recurrence_id ~ '^(\\d{8}(T\\d{6}Z)?)?$'),
        sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
        dtstamp timestamptz,
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
        organizer_address text NOT NULL, organizer_name text, attendee_address text, attendee_name text,
        title text NOT NULL, description text, location text,
        start_at timestamptz NOT NULL, end_at timestamptz NOT NULL, all_day boolean NOT NULL DEFAULT false,
        recurrence_rule text, time_zone text,
        response text CHECK (response IS NULL OR response IN ('accepted', 'tentative', 'declined')),
        responded_at timestamptz, reply_revision integer NOT NULL DEFAULT 0, event_time_zone text,
        message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (end_at > start_at), UNIQUE (user_id, uid, recurrence_id));
      CREATE TABLE calendar_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL,
        description text, location text, event_date text NOT NULL, start_time text NOT NULL, duration_minutes integer NOT NULL,
        calendar uuid NOT NULL REFERENCES calendars(id), tone text, recurrence_rule text, all_day boolean NOT NULL DEFAULT false,
        invitation_id uuid REFERENCES calendar_invitations(id) ON DELETE SET NULL);
      CREATE UNIQUE INDEX calendar_events_invitation_day_idx ON calendar_events(invitation_id, event_date) WHERE invitation_id IS NOT NULL;
    `);
  });

  beforeEach(async () => {
    providerCalls = 0;
    await sql.unsafe(
      'TRUNCATE users, threads, messages, attachments, message_read_receipts, outbound_attachments, scheduled_sends, outbound_email_quotas, outbound_deliveries, outbound_delivery_uploads, calendars, calendar_invitations, calendar_events CASCADE',
    );
    await sql`INSERT INTO users(id, email) VALUES (${OWNER}, 'alex@personal.example')`;
    await sql`INSERT INTO calendars(id, user_id, name) VALUES (${CALENDAR}, ${OWNER}, 'Personal')`;
  });

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DROP SCHEMA ${SCHEMA} CASCADE`);
      await sql.end();
    }
  });

  /** Stores the mail an invitation arrived in and reads it, as the reader does. */
  async function readInvitationMail(ics, { envelopeTo = SENDER } = {}) {
    const id = crypto.randomUUID();
    await sql`
      INSERT INTO messages(id, thread_id, user_id, from_address, subject, message_id, headers, envelope_to, sent_at)
      VALUES (${id}, ${crypto.randomUUID()}, ${OWNER}, ${ORGANISER}, 'Invitation',
              ${`<${id}@calendar.example>`}, '[]'::jsonb, ${envelopeTo}, now())
    `;
    return readStoredMail(id, ics, envelopeTo);
  }

  /** Reads a stored mail again. */
  async function readStoredMail(id, ics, envelopeTo = SENDER) {
    const parsed = parseCalendarInvitation(ics);
    if (!parsed) throw new Error('The fixture is not an invitation');
    const synced = await syncInvitation(
      sql,
      { id, userId: OWNER, ownerEmail: 'alex@personal.example', envelopeTo },
      parsed,
      SENDER,
    );
    // Loosely typed: most tests go straight on to use an invitation they
    // have just asserted is there.
    /** @type {any} */
    const view = synced ? invitationView(synced, SENDER) : null;
    return { messageId: id, view };
  }

  function sendServices(outcome = () => ({ status: 'sent' })) {
    /** @type {{payload: any, key: string}[]} */
    const sent = [];
    const services = /** @type {any} */ ({
      env: { EMAIL_FROM, RESEND_API_KEY: 'test-key' },
      sendProvider: vi.fn(async (payload, key) => {
        sent.push({ payload, key });
        const result = outcome();
        providerCalls += 1;
        return result.status === 'sent'
          ? { status: 'sent', providerId: `provider-${providerCalls}` }
          : { status: result.status, providerId: null };
      }),
      indexSentMessage: vi.fn(),
      indexSentMessages: vi.fn(),
    });
    return { services, sent };
  }

  /** @param {any} services @param {string} invitationId @param {string} response @param {string} [timeZone] */
  function reply(services, invitationId, response, timeZone = 'Europe/London', database = sql) {
    return handleInvitationReply(
      database,
      OWNER,
      new Request('https://send-api.example/send/invitation-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitationId, response, timeZone }),
      }),
      services,
    );
  }

  /** The reply as the organiser's calendar would read it. */
  function replyCalendar(payload) {
    const [attachment] = payload.attachments;
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(attachment.content), (character) => character.charCodeAt(0)),
    );
    const events = Object.values(ical.parseICS(text)).filter(
      (value) => /** @type {any} */ (value).type === 'VEVENT',
    );
    return { attachment, text, event: /** @type {any} */ (events[0]), count: events.length };
  }

  const entries = () =>
    sql`SELECT event_date, start_time, duration_minutes, all_day, recurrence_rule, tone, calendar
        FROM calendar_events ORDER BY event_date`;

  it('records an invitation once however often, and in whatever order, its mail is read', async () => {
    const first = await readInvitationMail(invitationIcs());
    const again = await readStoredMail(first.messageId, invitationIcs());
    const forwarded = await readInvitationMail(invitationIcs());

    expect(await sql`SELECT id FROM calendar_invitations`).toHaveLength(1);
    expect(again.view).toMatchObject({ id: first.view?.id, current: true, response: null });
    expect(forwarded.view).toMatchObject({ id: first.view?.id, current: true });
    expect(first.view).toMatchObject({
      status: 'active',
      title: 'Team sync',
      start_at: '2026-12-01T10:00:00.000Z',
      organizer: { name: 'Olive Organiser', address: ORGANISER },
      attendee: SENDER,
      can_reply: true,
      reply_blocked: null,
    });
  });

  it('keeps the newest revision when an older one is read after it', async () => {
    const revised = await readInvitationMail(
      invitationIcs({
        sequence: 2,
        dtstamp: '20261118T090000Z',
        start: 'DTSTART;TZID=Europe/London:20261202T140000',
        end: 'DTEND;TZID=Europe/London:20261202T150000',
      }),
    );
    const original = await readInvitationMail(invitationIcs());
    // Same sequence, earlier DTSTAMP: a copy that left before the stored one.
    const earlierCopy = await readInvitationMail(
      invitationIcs({ sequence: 2, dtstamp: '20261118T080000Z', title: 'Old title' }),
    );

    for (const stale of [original, earlierCopy]) {
      expect(stale.view).toMatchObject({
        id: revised.view?.id,
        current: false,
        latest_message_id: revised.messageId,
        title: 'Team sync',
        start_at: '2026-12-02T14:00:00.000Z',
      });
    }
    const [stored] = await sql`SELECT sequence, title FROM calendar_invitations`;
    expect(stored).toEqual({ sequence: 2, title: 'Team sync' });
  });

  it('answers the organiser once, as the invited address, and adds one calendar entry', async () => {
    const { view, messageId } = await readInvitationMail(invitationIcs({ sequence: 3 }));
    const { services, sent } = sendServices();

    const response = await reply(services, view.id, 'accepted', 'America/New_York');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ sent: true, invitation: { id: view.id, response: 'accepted' } });

    expect(sent).toHaveLength(1);
    const { payload } = sent[0];
    expect(payload).toMatchObject({
      from: EMAIL_FROM,
      to: [ORGANISER],
      subject: 'Accepted: Team sync',
    });
    expect(payload.text).toContain('Alex Guest has accepted this invitation.');
    // Threads under the invitation in the organiser's mail app.
    expect(payload.headers['In-Reply-To']).toBe(`<${messageId}@calendar.example>`);

    const { attachment, text, event, count } = replyCalendar(payload);
    expect(attachment).toMatchObject({
      filename: 'invite.ics',
      contentType: 'text/calendar; charset=utf-8; method=REPLY',
    });
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(count).toBe(1);
    expect(event).toMatchObject({
      method: 'REPLY',
      uid: 'team-sync@calendar.example',
      sequence: 3,
      organizer: { val: `mailto:${ORGANISER}`, params: { CN: 'Olive Organiser' } },
      attendee: { val: `mailto:${SENDER}`, params: { PARTSTAT: 'ACCEPTED', CN: 'Alex Guest' } },
    });
    expect(event.start.toISOString()).toBe('2026-12-01T10:00:00.000Z');

    // 10:00 in London is 05:00 in New York, where this person keeps their calendar.
    expect(await entries()).toEqual([
      {
        event_date: '2026-12-01',
        start_time: '05:00',
        duration_minutes: 60,
        all_day: false,
        recurrence_rule: null,
        tone: 'accepted',
        calendar: CALENDAR,
      },
    ]);
    expect(body.invitation.event).toMatchObject({ date: '2026-12-01' });
    const [copy] = await sql`SELECT subject, is_sent FROM messages WHERE is_sent`;
    expect(copy).toEqual({ subject: 'Accepted: Team sync', is_sent: true });

    // The same answer again, a double click or a replayed request, sends nothing.
    const repeated = await reply(services, view.id, 'accepted', 'America/New_York');
    expect(await repeated.json()).toMatchObject({
      sent: false,
      invitation: { response: 'accepted' },
    });
    expect(sent).toHaveLength(1);
    expect(await entries()).toHaveLength(1);
  });

  it('retries an unconfirmed reply under one provider key with the identical message', async () => {
    const { view } = await readInvitationMail(invitationIcs());
    const outcomes = [{ status: 'retry' }, { status: 'sent' }];
    const { services, sent } = sendServices(() => /** @type {any} */ (outcomes.shift()));

    const interrupted = await reply(services, view.id, 'tentative');
    expect(interrupted.status).toBe(503);
    expect(await interrupted.json()).toMatchObject({ code: 'DELIVERY_PENDING' });
    expect((await sql`SELECT response FROM calendar_invitations`)[0].response).toBeNull();
    expect(await entries()).toEqual([]);

    const retried = await reply(services, view.id, 'tentative');
    expect(retried.status).toBe(200);
    // The provider deduplicates on the key, and the frozen payload (DTSTAMP
    // included) is what is offered both times.
    expect(sent).toHaveLength(2);
    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[1].payload).toEqual(sent[0].payload);
    expect(await sql`SELECT id FROM outbound_deliveries`).toHaveLength(1);
    expect((await entries())[0]).toMatchObject({ tone: 'suggested' });
  });

  it('does not send again when the answer was delivered but could not be recorded', async () => {
    const { view } = await readInvitationMail(invitationIcs());
    const { services, sent } = sendServices();
    let fail = true;
    const failingOnce = new Proxy(sql, {
      get(target, property) {
        if (property !== 'begin') return Reflect.get(target, property);
        return (/** @type {any} */ callback) =>
          target.begin(async (tx) => {
            const guarded = new Proxy(tx, {
              apply(inner, self, args) {
                if (fail && args[0].join(' ').includes('UPDATE calendar_invitations SET')) {
                  fail = false;
                  throw new Error('connection lost');
                }
                return Reflect.apply(inner, self, args);
              },
            });
            return callback(guarded);
          });
      },
    });

    await expect(
      reply(services, view.id, 'accepted', 'Europe/London', failingOnce),
    ).rejects.toThrow('connection lost');
    expect(sent).toHaveLength(1);
    expect((await sql`SELECT response FROM calendar_invitations`)[0].response).toBeNull();

    const retried = await reply(services, view.id, 'accepted');
    expect(await retried.json()).toMatchObject({
      sent: true,
      invitation: { response: 'accepted' },
    });
    expect(sent).toHaveLength(1);
    expect(await entries()).toHaveLength(1);
  });

  it('sends a fresh reply for each change of mind and takes a declined event off the calendar', async () => {
    const { view } = await readInvitationMail(invitationIcs());
    const { services, sent } = sendServices();

    await reply(services, view.id, 'accepted');
    expect(await entries()).toHaveLength(1);
    const declined = await reply(services, view.id, 'declined');
    expect(await declined.json()).toMatchObject({
      sent: true,
      invitation: { response: 'declined', event: null },
    });
    expect(await entries()).toEqual([]);
    await reply(services, view.id, 'accepted');

    expect(sent.map(({ payload }) => payload.subject)).toEqual([
      'Accepted: Team sync',
      'Declined: Team sync',
      'Accepted: Team sync',
    ]);
    expect(new Set(sent.map(({ key }) => key)).size).toBe(3);
    expect(replyCalendar(sent[1].payload).event.attendee.params.PARTSTAT).toBe('DECLINED');
    expect(await entries()).toHaveLength(1);
  });

  it('moves the one calendar entry when the organiser revises the event and asks for a new answer', async () => {
    const { view } = await readInvitationMail(invitationIcs());
    const { services, sent } = sendServices();
    await reply(services, view.id, 'accepted');

    const revised = await readInvitationMail(
      invitationIcs({
        sequence: 1,
        dtstamp: '20261119T090000Z',
        start: 'DTSTART;TZID=Europe/London:20261203T153000',
        end: 'DTEND;TZID=Europe/London:20261203T163000',
        title: 'Team sync (moved)',
      }),
    );

    expect(revised.view).toMatchObject({
      id: view.id,
      current: true,
      title: 'Team sync (moved)',
      response: null,
      responded_at: null,
    });
    expect(await sql`SELECT id FROM calendar_invitations`).toHaveLength(1);
    expect(await entries()).toEqual([
      expect.objectContaining({ event_date: '2026-12-03', start_time: '15:30', tone: 'suggested' }),
    ]);
    expect(revised.view?.event).toMatchObject({ date: '2026-12-03' });

    // Answering again names the new revision.
    await reply(services, view.id, 'accepted');
    expect(replyCalendar(sent[1].payload).event.sequence).toBe(1);
    expect(await entries()).toEqual([
      expect.objectContaining({ event_date: '2026-12-03', tone: 'accepted' }),
    ]);
  });

  it('keeps the answer when a revision changes details only', async () => {
    const { view } = await readInvitationMail(invitationIcs());
    await reply(sendServices().services, view.id, 'accepted');
    const detail = await readInvitationMail(
      invitationIcs({ dtstamp: '20261119T090000Z', title: 'Team sync: agenda attached' }),
    );
    expect(detail.view).toMatchObject({
      response: 'accepted',
      title: 'Team sync: agenda attached',
    });
    expect(await entries()).toHaveLength(1);
  });

  it('removes a cancelled event and refuses to answer it', async () => {
    const { view } = await readInvitationMail(invitationIcs());
    const { services, sent } = sendServices();
    await reply(services, view.id, 'accepted');

    const cancelled = await readInvitationMail(
      invitationIcs({ method: 'CANCEL', dtstamp: '20261120T090000Z' }),
    );
    expect(cancelled.view).toMatchObject({
      id: view.id,
      status: 'cancelled',
      can_reply: false,
      reply_blocked: 'cancelled',
      event: null,
    });
    expect(await entries()).toEqual([]);

    // The invitation it cancels, read again afterwards, does not bring it back.
    const reread = await readInvitationMail(invitationIcs());
    expect(reread.view).toMatchObject({ status: 'cancelled', current: false });

    const refused = await reply(services, view.id, 'declined');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'INVITATION_CANCELLED' });
    expect(sent).toHaveLength(1);
  });

  it('ignores a revision that names a different organiser', async () => {
    const { view } = await readInvitationMail(invitationIcs());
    const forged = invitationIcs({ method: 'CANCEL', sequence: 5 }).replaceAll(
      ORGANISER,
      'mallory@elsewhere.example',
    );
    expect((await readInvitationMail(forged)).view).toBeNull();
    const [stored] =
      await sql`SELECT status, sequence FROM calendar_invitations WHERE id = ${view.id}`;
    expect(stored).toEqual({ status: 'active', sequence: 0 });
  });

  it('explains an invitation sent to another of the person’s addresses and sends nothing for it', async () => {
    const { view } = await readInvitationMail(
      invitationIcs({ attendee: 'alex@personal.example' }),
      { envelopeTo: 'alex@personal.example' },
    );
    expect(view).toMatchObject({
      attendee: 'alex@personal.example',
      sender: SENDER,
      can_reply: false,
      reply_blocked: 'alias',
    });

    const { services, sent } = sendServices();
    const refused = await reply(services, view.id, 'accepted');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'INVITATION_ALIAS' });
    expect(sent).toEqual([]);
    expect(await sql`SELECT id FROM outbound_deliveries`).toEqual([]);
    expect(await entries()).toEqual([]);
  });

  it('reports an invitation with no guest of this mailbox as not addressed to it', async () => {
    const { view } = await readInvitationMail(invitationIcs({ attendee: 'someone@else.example' }));
    expect(view).toMatchObject({ attendee: null, can_reply: false, reply_blocked: 'not_invited' });
  });

  it('stores a weekly series as one repeating entry and answers for the series', async () => {
    const { view } = await readInvitationMail(
      invitationIcs({ extra: ['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270105T100000Z'] }),
    );
    expect(view).toMatchObject({ recurring: true, occurrence: false });
    const { services, sent } = sendServices();
    await reply(services, view.id, 'accepted');

    expect(await entries()).toEqual([
      expect.objectContaining({
        event_date: '2026-12-01',
        start_time: '10:00',
        recurrence_rule: 'WEEKLY;BYDAY=TU;UNTIL=2027-01-05',
      }),
    ]);
    expect(replyCalendar(sent[0].payload).text).not.toContain('RECURRENCE-ID');

    // One moved occurrence is answered on its own, by RECURRENCE-ID, and is
    // not added beside the series already on the calendar.
    const occurrence = await readInvitationMail(
      invitationIcs({
        sequence: 1,
        start: 'DTSTART;TZID=Europe/London:20261208T140000',
        end: 'DTEND;TZID=Europe/London:20261208T150000',
        extra: ['RECURRENCE-ID;TZID=Europe/London:20261208T100000'],
      }),
    );
    expect(occurrence.view).toMatchObject({ recurring: false, occurrence: true });
    expect(occurrence.view?.id).not.toBe(view.id);
    await reply(services, occurrence.view.id, 'declined');
    expect(replyCalendar(sent[1].payload).text).toContain('RECURRENCE-ID:20261208T100000Z');
    expect(await sql`SELECT id FROM calendar_invitations`).toHaveLength(2);
    expect(await entries()).toHaveLength(1);
  });

  it('adds only the first occurrence of a series the calendar cannot repeat', async () => {
    const { view } = await readInvitationMail(
      invitationIcs({ extra: ['RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=1TU'] }),
    );
    await reply(sendServices().services, view.id, 'accepted');
    expect(await entries()).toEqual([
      expect.objectContaining({ event_date: '2026-12-01', recurrence_rule: null }),
    ]);
  });

  it('files an all-day invitation as one entry per day it covers', async () => {
    const { view } = await readInvitationMail(
      invitationIcs({
        uid: 'offsite@calendar.example',
        start: 'DTSTART;VALUE=DATE:20261224',
        end: 'DTEND;VALUE=DATE:20261226',
        title: 'Offsite',
      }),
    );
    expect(view).toMatchObject({ all_day: true, start_at: '2026-12-24T00:00:00.000Z' });
    const { services, sent } = sendServices();
    // An all-day event is the same days wherever the calendar is kept.
    await reply(services, view.id, 'accepted', 'Pacific/Auckland');

    expect(await entries()).toEqual([
      expect.objectContaining({ event_date: '2026-12-24', all_day: true, duration_minutes: 1440 }),
      expect.objectContaining({ event_date: '2026-12-25', all_day: true, duration_minutes: 1440 }),
    ]);
    const { text } = replyCalendar(sent[0].payload);
    expect(text).toContain('DTSTART;VALUE=DATE:20261224');
    expect(text).toContain('DTEND;VALUE=DATE:20261226');
  });

  it('keeps an entry in the calendar the person moved it to', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    await sql`INSERT INTO calendars(id, user_id, name) VALUES (${other}, ${OWNER}, 'Work')`;
    const { view } = await readInvitationMail(invitationIcs());
    await reply(sendServices().services, view.id, 'accepted');
    await sql`UPDATE calendar_events SET calendar = ${other}`;

    await readInvitationMail(
      invitationIcs({
        sequence: 1,
        start: 'DTSTART;TZID=Europe/London:20261204T100000',
        end: 'DTEND;TZID=Europe/London:20261204T110000',
      }),
    );
    expect(await entries()).toEqual([
      expect.objectContaining({ event_date: '2026-12-04', calendar: other }),
    ]);
  });
});
