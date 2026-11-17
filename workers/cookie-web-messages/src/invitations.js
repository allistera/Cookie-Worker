// Keeps calendar_invitations in step with the invitation mail a person reads.
// Each REQUEST or CANCEL is one revision of an event, identified by its UID
// (and RECURRENCE-ID for a single occurrence) and ordered by SEQUENCE, then
// DTSTAMP. Reading a message applies its revision when it is the newest seen
// so far; an older or repeated one changes nothing, so mail can be opened in
// any order, any number of times.

import {
  deleteInvitationEvents,
  invitationReplyBlock,
  replaceInvitationEvents,
  validInvitationTimeZone,
} from '../../../shared/calendarInvitation.js';
import { normaliseAddress } from '../../../shared/outOfOffice.js';

/**
 * @typedef {import('./calendarInvite.js').ParsedInvitation} ParsedInvitation
 */

/**
 * The guest the person can be answered as: the address Cookie sends from when
 * it is invited, otherwise another address of theirs (their account address,
 * or the one this message was delivered to), which the reader explains
 * instead of answering for.
 *
 * @param {ParsedInvitation} parsed
 * @param {(string | null)[]} owned Most preferred first.
 */
function ownedAttendee(parsed, owned) {
  for (const address of owned) {
    const match = address && parsed.attendees.find((attendee) => attendee.address === address);
    if (match) return match;
  }
  return null;
}

/**
 * How a message's revision relates to the stored one.
 * @param {ParsedInvitation} parsed
 * @param {any} stored A calendar_invitations row.
 * @returns {'newer' | 'same' | 'older'}
 */
export function compareRevision(parsed, stored) {
  if (parsed.sequence !== stored.sequence) {
    return parsed.sequence > stored.sequence ? 'newer' : 'older';
  }
  const incoming = parsed.dtstamp ? Date.parse(parsed.dtstamp) : NaN;
  const current = stored.dtstamp ? new Date(stored.dtstamp).getTime() : NaN;
  if (!Number.isFinite(incoming) || !Number.isFinite(current) || incoming === current) {
    return 'same';
  }
  return incoming > current ? 'newer' : 'older';
}

/**
 * Records the revision a message carries and returns the invitation as it
 * now stands, with `current` false when the message is an older revision
 * than the stored one.
 *
 * An invitation the person organised is not theirs to answer and is not
 * tracked. A revision whose organiser differs from the stored one is ignored:
 * only an event's organiser may change or cancel it.
 *
 * @param {import('postgres').Sql} sql
 * @param {{id: string, userId: string, ownerEmail: string | null, envelopeTo: string | null}} message
 * @param {ParsedInvitation} parsed
 * @param {string | null} sender The address Cookie sends as.
 * @returns {Promise<{invitation: any, current: boolean, event: {id: string, date: string} | null} | null>}
 */
export async function syncInvitation(sql, message, parsed, sender) {
  const owned = [
    sender,
    normaliseAddress(message.ownerEmail),
    normaliseAddress(message.envelopeTo),
  ];
  if (owned.includes(parsed.organizer.address)) return null;
  const attendee = ownedAttendee(parsed, owned);
  const cancelled = parsed.method === 'cancel';

  return /** @type {any} */ (sql).begin(async (/** @type {any} */ tx) => {
    const [created] = await tx`
      INSERT INTO calendar_invitations
        (user_id, uid, recurrence_id, sequence, dtstamp, status, organizer_address,
         organizer_name, attendee_address, attendee_name, title, description, location,
         start_at, end_at, all_day, recurrence_rule, time_zone, message_id)
      VALUES
        (${message.userId}, ${parsed.uid}, ${parsed.recurrenceId}, ${parsed.sequence},
         ${parsed.dtstamp}, ${cancelled ? 'cancelled' : 'active'}, ${parsed.organizer.address},
         ${parsed.organizer.name}, ${attendee?.address ?? null}, ${attendee?.name ?? null},
         ${parsed.title}, ${parsed.description}, ${parsed.location}, ${parsed.startAt},
         ${parsed.endAt}, ${parsed.allDay}, ${parsed.recurrenceRule}, ${parsed.timeZone},
         ${message.id})
      ON CONFLICT (user_id, uid, recurrence_id) DO NOTHING
      RETURNING *
    `;
    if (created) return { invitation: created, current: true, event: null };

    const [stored] = await tx`
      SELECT * FROM calendar_invitations
      WHERE user_id = ${message.userId} AND uid = ${parsed.uid}
        AND recurrence_id = ${parsed.recurrenceId}
      FOR UPDATE
    `;
    if (!stored || stored.organizer_address !== parsed.organizer.address) return null;

    const order = compareRevision(parsed, stored);
    // A cancellation carries the sequence of the revision it withdraws, so it
    // applies to that revision as well as to older ones.
    const applies =
      order === 'newer' || (order === 'same' && cancelled && stored.status === 'active');
    let invitation = stored;
    if (applies) {
      // A new sequence means the organiser changed something a guest answers
      // for (the time, usually), which puts the answer back to "not yet".
      const reset = !cancelled && parsed.sequence > stored.sequence;
      [invitation] = await tx`
        UPDATE calendar_invitations SET
          sequence = ${parsed.sequence},
          dtstamp = ${parsed.dtstamp ?? stored.dtstamp},
          status = ${cancelled ? 'cancelled' : 'active'},
          organizer_name = ${parsed.organizer.name},
          attendee_address = ${attendee?.address ?? stored.attendee_address},
          attendee_name = ${attendee ? attendee.name : stored.attendee_name},
          title = ${parsed.title},
          description = ${parsed.description},
          location = ${parsed.location},
          start_at = ${parsed.startAt},
          end_at = ${parsed.endAt},
          all_day = ${parsed.allDay},
          recurrence_rule = ${parsed.recurrenceRule},
          time_zone = ${parsed.timeZone},
          response = ${reset ? null : stored.response},
          responded_at = ${reset ? null : stored.responded_at},
          message_id = ${message.id},
          updated_at = now()
        WHERE id = ${stored.id}
        RETURNING *
      `;
      const timeZone = validInvitationTimeZone(invitation.event_time_zone);
      if (cancelled) {
        await deleteInvitationEvents(tx, invitation);
      } else if (timeZone) {
        await replaceInvitationEvents(tx, invitation, {
          timeZone,
          tone: invitation.response === 'accepted' ? 'accepted' : 'suggested',
          onlyIfPresent: true,
        });
      }
    }
    const [event] = await tx`
      SELECT id, event_date AS date FROM calendar_events
      WHERE invitation_id = ${invitation.id} AND user_id = ${message.userId}
      ORDER BY event_date
      LIMIT 1
    `;
    return {
      invitation,
      current: order !== 'older',
      event: /** @type {{id: string, date: string} | undefined} */ (event) ?? null,
    };
  });
}

/** @param {unknown} value */
const isoOrNull = (value) => {
  const date = value ? new Date(/** @type {any} */ (value)) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/**
 * The invitation as the reader shows it. Addresses here are the person's own
 * or the organiser's, both already in the mail they are reading.
 *
 * @param {NonNullable<Awaited<ReturnType<typeof syncInvitation>>>} synced
 * @param {string | null} sender
 */
export function invitationView({ invitation, current, event }, sender) {
  const blocked = invitationReplyBlock(invitation, sender);
  return {
    id: invitation.id,
    status: invitation.status,
    current,
    latest_message_id: invitation.message_id ?? null,
    title: invitation.title,
    location: invitation.location ?? null,
    start_at: isoOrNull(invitation.start_at),
    end_at: isoOrNull(invitation.end_at),
    all_day: invitation.all_day === true,
    recurring: Boolean(invitation.recurrence_rule) && !invitation.recurrence_id,
    occurrence: Boolean(invitation.recurrence_id),
    organizer: { name: invitation.organizer_name ?? null, address: invitation.organizer_address },
    attendee: invitation.attendee_address ?? null,
    sender,
    can_reply: blocked === null,
    reply_blocked: blocked,
    response: invitation.response ?? null,
    responded_at: isoOrNull(invitation.responded_at),
    event,
  };
}
