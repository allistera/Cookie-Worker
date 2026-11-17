// POST /send/invitation-reply answers a calendar invitation: it mails the
// organiser an iTIP REPLY (RFC 5546) as an iMIP calendar part (RFC 6047),
// records the answer, and puts the event on, or takes it off, the calendar.
//
// Nothing is sent until the person answers, and only for the guest whose
// address is the one Cookie sends from: the organiser's calendar matches a
// reply to a guest by address, and a reply for any other guest would not have
// come from that guest.

import {
  deleteInvitationEvents,
  INVITATION_RESPONSES,
  invitationReplyBlock,
  invitationSender,
  replaceInvitationEvents,
  validInvitationTimeZone,
} from '../../../shared/calendarInvitation.js';
import { hasControlChars, isValidEmailAddress } from '../../../shared/email-validation.js';
import { validId } from '../../../shared/pagination.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { DeliveryError } from './deliveryLedger.js';
import { claimOutboundEmailQuota, deliverMail, refundOutboundEmailQuota } from './outbound.js';

const PARTSTAT = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' };
const SUBJECT_PREFIX = {
  accepted: 'Accepted',
  tentative: 'Tentatively accepted',
  declined: 'Declined',
};
const ANSWER = {
  accepted: 'has accepted',
  tentative: 'has tentatively accepted',
  declined: 'has declined',
};
const BLOCKED = {
  cancelled: { status: 409, error: 'This invitation was cancelled by its organiser' },
  not_configured: { status: 503, error: 'Email sending is not configured' },
  alias: {
    status: 403,
    error: 'This invitation is addressed to an address Cookie cannot send from',
  },
  not_invited: { status: 403, error: 'This mailbox is not a guest of this invitation' },
};

/** @param {string} value */
function escapeText(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * A parameter value cannot hold a double quote or a control character, so a
 * name loses them and is always quoted.
 * @param {string | null} name
 */
function cnParam(name) {
  const text = [...String(name ?? '')]
    .filter((character) => character !== '"' && !hasControlChars(character))
    .join('')
    .trim();
  return text ? `;CN="${text}"` : '';
}

/**
 * RFC 5545 section 3.1: a content line is at most 75 octets, continued on the
 * next line after a single space. Splits between characters, never inside one.
 * @param {string} line
 */
function fold(line) {
  const encoder = new TextEncoder();
  const lines = [];
  let current = '';
  let octets = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (octets + size > 75) {
      lines.push(current);
      current = ' ';
      octets = 1;
    }
    current += character;
    octets += size;
  }
  lines.push(current);
  return lines.join('\r\n');
}

/** @param {Date} date */
const utcBasic = (date) =>
  `${date.toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')}Z`;

/** @param {Date} date */
const utcDay = (date) => date.toISOString().slice(0, 10).replaceAll('-', '');

/**
 * The reply's calendar object: the invitation's own UID, SEQUENCE and, for
 * one occurrence of a series, RECURRENCE-ID, so the organiser's calendar can
 * tell which event and which revision is being answered, and exactly one
 * ATTENDEE, the guest answering.
 *
 * @param {any} invitation A calendar_invitations row.
 * @param {'accepted' | 'tentative' | 'declined'} response
 * @param {Date} now
 */
export function buildReplyCalendar(invitation, response, now) {
  const start = new Date(invitation.start_at);
  const end = new Date(invitation.end_at);
  const allDay = invitation.all_day === true;
  const recurrenceId = String(invitation.recurrence_id ?? '');
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Cookie//Cookie Mail//EN',
    'VERSION:2.0',
    'METHOD:REPLY',
    'BEGIN:VEVENT',
    `UID:${escapeText(invitation.uid)}`,
    ...(recurrenceId
      ? [
          recurrenceId.length === 8
            ? `RECURRENCE-ID;VALUE=DATE:${recurrenceId}`
            : `RECURRENCE-ID:${recurrenceId}`,
        ]
      : []),
    `DTSTAMP:${utcBasic(now)}`,
    allDay ? `DTSTART;VALUE=DATE:${utcDay(start)}` : `DTSTART:${utcBasic(start)}`,
    allDay ? `DTEND;VALUE=DATE:${utcDay(end)}` : `DTEND:${utcBasic(end)}`,
    `SEQUENCE:${invitation.sequence}`,
    `ORGANIZER${cnParam(invitation.organizer_name)}:mailto:${invitation.organizer_address}`,
    `ATTENDEE;PARTSTAT=${PARTSTAT[response]}${cnParam(invitation.attendee_name)}:mailto:${invitation.attendee_address}`,
    `SUMMARY:${escapeText(invitation.title)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/**
 * When the event is, in words, for the plain-text part of the reply.
 * @param {any} invitation
 */
function eventTime(invitation) {
  const start = new Date(invitation.start_at);
  if (invitation.all_day === true) {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeZone: 'UTC' }).format(start);
  }
  const timeZone = validInvitationTimeZone(invitation.time_zone) ?? 'UTC';
  // dateStyle and timeStyle cannot be combined with timeZoneName, and the
  // zone is what tells the organiser which clock the time is on.
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(start);
}

/** @param {unknown} value */
function singleLine(value) {
  return [...String(value ?? '')]
    .map((character) => (hasControlChars(character) ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The mail that carries the reply. Resend sends a calendar object as an
 * attachment and keeps the `method` parameter on its Content-Type, which is
 * what a receiving calendar reads to treat the part as a reply.
 *
 * @param {any} invitation
 * @param {'accepted' | 'tentative' | 'declined'} response
 * @param {Date} now
 */
export function buildReplyMail(invitation, response, now) {
  const title = singleLine(invitation.title) || 'Untitled event';
  const guest = singleLine(invitation.attendee_name) || invitation.attendee_address;
  const calendar = buildReplyCalendar(invitation, response, now);
  return {
    subject: `${SUBJECT_PREFIX[response]}: ${title}`,
    text: `${guest} ${ANSWER[response]} this invitation.\n\n${title}\n${eventTime(invitation)}\n`,
    attachment: {
      filename: 'invite.ics',
      content: btoa(String.fromCharCode(...new TextEncoder().encode(calendar))),
      contentType: 'text/calendar; charset=utf-8; method=REPLY',
    },
  };
}

/**
 * Stores the answer, unless a later one is already stored, and makes the
 * calendar match whichever answer stands.
 *
 * @param {import('postgres').Sql} sql
 * @param {any} invitation The row the reply was built from.
 * @param {string} response
 * @param {Date} answeredAt
 * @param {string} timeZone
 */
async function recordResponse(sql, invitation, response, answeredAt, timeZone) {
  return sql.begin(async (tx) => {
    const [updated] = await tx`
      UPDATE calendar_invitations SET
        response = ${response},
        responded_at = ${answeredAt.toISOString()},
        reply_revision = reply_revision + 1,
        event_time_zone = ${timeZone},
        updated_at = now()
      WHERE id = ${invitation.id} AND user_id = ${invitation.user_id}
        AND status = 'active' AND sequence = ${invitation.sequence}
        AND (reply_revision = ${invitation.reply_revision}
             OR responded_at IS NULL OR responded_at < ${answeredAt.toISOString()})
      RETURNING *
    `;
    if (!updated) return null;
    return { invitation: updated, event: await syncEvents(tx, updated, timeZone) };
  });
}

/**
 * @param {any} tx
 * @param {any} invitation
 * @param {string} timeZone
 */
async function syncEvents(tx, invitation, timeZone) {
  if (invitation.response === 'declined') {
    await deleteInvitationEvents(tx, invitation);
    return null;
  }
  const { event } = await replaceInvitationEvents(tx, invitation, {
    timeZone,
    tone: invitation.response === 'accepted' ? 'accepted' : 'suggested',
  });
  return event;
}

/** @param {any} invitation @param {{id: string, date: string} | null} event @param {boolean} sent */
function replyResponse(invitation, event, sent) {
  return Response.json({
    invitation: {
      id: invitation.id,
      response: invitation.response,
      responded_at: new Date(invitation.responded_at).toISOString(),
      event,
    },
    sent,
  });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {Request} request
 * @param {import('./outbound.js').SendServices} services
 * @param {{deliver?: typeof deliverMail, now?: () => Date}} [overrides]
 */
export async function handleInvitationReply(sql, userId, request, services, overrides = {}) {
  if (request.method !== 'POST') {
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    );
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const errorResponse = bodyErrorResponse(error);
    if (errorResponse) return errorResponse;
    throw error;
  }
  const id = validId(body.invitationId) ? String(body.invitationId) : null;
  const response = /** @type {'accepted' | 'tentative' | 'declined'} */ (String(body.response));
  const timeZone = validInvitationTimeZone(body.timeZone);
  if (!id || !INVITATION_RESPONSES.includes(response) || !timeZone) {
    return Response.json(
      { error: 'invitationId, response and a valid timeZone are required' },
      { status: 400 },
    );
  }

  const [invitation] = await sql`
    SELECT * FROM calendar_invitations WHERE id = ${id} AND user_id = ${userId}
  `;
  if (!invitation) return Response.json({ error: 'Invitation not found' }, { status: 404 });
  const blocked = invitationReplyBlock(invitation, invitationSender(services.env));
  if (blocked) {
    const { status, error } = BLOCKED[blocked];
    return Response.json({ error, code: `INVITATION_${blocked.toUpperCase()}` }, { status });
  }
  if (!isValidEmailAddress(String(invitation.organizer_address))) {
    return Response.json({ error: 'This invitation has no organiser to answer' }, { status: 422 });
  }

  // The same answer again sends nothing. It still puts the event back if it
  // was taken off the calendar by hand.
  if (invitation.response === response) {
    const refiled = await sql.begin(async (tx) => {
      // Held to the end of the transaction, so two identical requests file
      // the event one after the other instead of on top of each other.
      const [locked] = await tx`
        SELECT * FROM calendar_invitations WHERE id = ${id} AND user_id = ${userId} FOR UPDATE
      `;
      if (locked?.status !== 'active' || locked.response !== response) return null;
      return { invitation: locked, event: await syncEvents(tx, locked, timeZone) };
    });
    if (refiled) return replyResponse(refiled.invitation, refiled.event, false);
    return Response.json(
      { error: 'This invitation changed while it was being answered', code: 'INVITATION_CHANGED' },
      { status: 409 },
    );
  }

  try {
    const quota = await claimOutboundEmailQuota(sql, userId);
    if (!quota.authorized) {
      return Response.json({ error: 'Mailbox access is not provisioned' }, { status: 403 });
    }
    if (!quota.quota_claimed) {
      return Response.json(
        { error: 'Outbound email quota exceeded; try again shortly' },
        { status: 429 },
      );
    }
  } catch (err) {
    console.error('failed to enforce outbound email quota:', /** @type {Error} */ (err).message);
    return Response.json({ error: 'Email sending is temporarily unavailable' }, { status: 503 });
  }

  const now = (overrides.now ?? (() => new Date()))();
  const mail = buildReplyMail(invitation, response, now);
  const deliver = overrides.deliver ?? deliverMail;
  // Each answer is one delivery. The key names the invitation, the revision
  // answered and how many answers came before, so a retry of this request
  // resumes the same delivery (the ledger never sends it twice) while a later
  // change of mind, back to an earlier answer included, is a new one.
  const idempotencyKey = `invitation-reply/${invitation.id}/${invitation.sequence}/${invitation.reply_revision}/${response}`;
  let delivered;
  try {
    delivered = await deliver(
      sql,
      userId,
      {
        recipients: [invitation.organizer_address],
        subject: mail.subject,
        text: mail.text,
        html: null,
        // Files the sent copy in the invitation's conversation and gives the
        // organiser's mail app the thread to put the reply under.
        replyToMessageId: invitation.message_id ?? null,
        idempotencyKey,
        inlineAttachments: [mail.attachment],
      },
      services,
    );
  } catch (err) {
    // Nothing was added to the organiser's mail by this attempt, or a retry
    // of this same request will find out: either way it gives its place in
    // the per-minute allowance back.
    await refundOutboundEmailQuota(sql, userId);
    if (!(err instanceof DeliveryError)) throw err;
    const resolved = err.code === 'DELIVERY_REJECTED' || err.code === 'DELIVERY_UNCERTAIN';
    if (resolved) {
      // The ledger will not send this delivery again. Moving the invitation
      // to its next answer lets the person answer afresh, which is a new
      // decision of theirs and not a retry of this one.
      await sql`
        UPDATE calendar_invitations SET reply_revision = reply_revision + 1, updated_at = now()
        WHERE id = ${invitation.id} AND user_id = ${userId}
          AND reply_revision = ${invitation.reply_revision}
      `;
    }
    return Response.json(
      {
        error:
          err.code === 'DELIVERY_REJECTED'
            ? 'The email provider rejected the reply, so the organiser was not told.'
            : err.code === 'DELIVERY_UNCERTAIN'
              ? 'Cookie could not confirm the reply was sent. Answer again to send it once more.'
              : 'The reply is still being sent. Try again shortly.',
        code: err.code,
      },
      { status: resolved ? 502 : 503, headers: resolved ? {} : { 'Retry-After': '5' } },
    );
  }
  if (delivered.inserted && delivered.messageUuid) services.indexSentMessage(delivered.messageUuid);
  // A resumed delivery had already been counted when it first went out.
  if (!delivered.inserted && delivered.messageUuid) await refundOutboundEmailQuota(sql, userId);

  const recorded = await recordResponse(sql, invitation, response, now, timeZone);
  if (recorded) return replyResponse(recorded.invitation, recorded.event, true);

  // The invitation moved on while the reply was in flight: a later answer is
  // stored, or the organiser revised or cancelled the event. Report what
  // stands rather than this request's answer.
  const [latest] = await sql`
    SELECT * FROM calendar_invitations WHERE id = ${id} AND user_id = ${userId}
  `;
  if (!latest?.response) {
    return Response.json(
      {
        error: 'This invitation changed while the reply was being sent',
        code: 'INVITATION_CHANGED',
      },
      { status: 409 },
    );
  }
  const [event] = await sql`
    SELECT id, event_date AS date FROM calendar_events
    WHERE invitation_id = ${id} AND user_id = ${userId}
    ORDER BY event_date
    LIMIT 1
  `;
  return replyResponse(
    latest,
    /** @type {{id: string, date: string} | undefined} */ (event) ?? null,
    true,
  );
}
