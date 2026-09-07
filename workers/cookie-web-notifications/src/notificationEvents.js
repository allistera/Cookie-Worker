// Ported from Cookie-Web's api/notification-event.js. Behaviorally identical
// (same queries, same validation, same response shapes/status codes) — only
// the (req, res) mutation style becomes returning a Response, since Workers
// speak Web-standard fetch.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} eventId
 */
export function claimNotificationEvent(sql, userId, eventId) {
  return sql`
    UPDATE browser_notification_events event
    SET claim_token = gen_random_uuid(),
        claimed_until = now() + interval '30 seconds'
    FROM messages message
    LEFT JOIN message_ai ai ON ai.message_id = message.id
    WHERE event.event_id = ${eventId}
      AND event.message_id = message.id
      AND event.user_id = ${userId}
      AND message.user_id = ${userId}
      AND NOT EXISTS (
        SELECT 1 FROM threads t
        WHERE t.id = message.thread_id AND t.user_id = ${userId} AND t.is_muted
      )
      AND (event.claimed_until IS NULL OR event.claimed_until < now())
      AND message.is_unread
      AND NOT message.is_sent
      AND NOT message.is_archived
      AND NOT message.is_deleted
      AND (message.scheduled_for IS NULL OR message.scheduled_for <= now())
      AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
    RETURNING event.event_id, event.claim_token, event.claimed_until,
              message.id AS message_id, message.from_name,
              message.from_address, message.subject
  `;
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} eventId
 */
export function findNotificationEventLease(sql, userId, eventId) {
  return sql`
    SELECT event.claimed_until
    FROM browser_notification_events event
    WHERE event.event_id = ${eventId}
      AND event.user_id = ${userId}
  `;
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} eventId
 * @param {string} claimToken
 */
export function acknowledgeNotificationEvent(sql, userId, eventId, claimToken) {
  return sql`
    DELETE FROM browser_notification_events event
    WHERE event.event_id = ${eventId}
      AND event.claim_token = ${claimToken}
      AND event.user_id = ${userId}
    RETURNING event.event_id
  `;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function json(status, body, headers = {}) {
  if (body === null) return new Response(null, { status, headers: { ...NO_STORE, ...headers } });
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

/**
 * Claims or acknowledges a browser notification event — the same two-step
 * lease Cookie-Web's api/notification-event.js served: `claim` leases the
 * event for 30 seconds so exactly one tab shows the notification, `ack`
 * deletes it once shown.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function handleNotificationEvent(sql, userId, body) {
  if (!['claim', 'ack'].includes(body?.action) || !UUID_RE.test(body?.eventId || '')) {
    return json(400, { error: 'A valid action and event id are required' });
  }
  if (body.action === 'ack' && !UUID_RE.test(body.claimToken || '')) {
    return json(400, { error: 'A valid claim token is required' });
  }

  if (body.action === 'ack') {
    await acknowledgeNotificationEvent(sql, userId, body.eventId, body.claimToken);
    return json(204, null);
  }

  const [claimed] = await claimNotificationEvent(sql, userId, body.eventId);
  if (!claimed) {
    const [event] = await findNotificationEventLease(sql, userId, body.eventId);
    if (event?.claimed_until && new Date(event.claimed_until) > new Date()) {
      // Retry-After is not a CORS-safelisted response header, so the
      // cross-origin caller only sees it through this expose header (it falls
      // back to 30 seconds anyway if a proxy strips either one).
      return json(
        423,
        { error: 'Notification event is already claimed' },
        {
          'Retry-After': '30',
          'Access-Control-Expose-Headers': 'Retry-After',
        },
      );
    }
    return json(204, null);
  }

  return json(200, {
    eventId: claimed.event_id,
    claimToken: claimed.claim_token,
    message: {
      id: claimed.message_id,
      sender: claimed.from_name || claimed.from_address,
      subject: claimed.subject,
    },
  });
}
