const DEFAULT_BASE_URL = 'https://ntfy.sh';
const TOPIC_RE = /^[A-Za-z0-9_-]{8,128}$/;
const COOKIE_ORIGIN = 'https://mail.infinitywave.online';

/**
 * @param {{topic: string, messageId: string, sender?: string | null, subject?: string | null, title?: string | null}} notification
 * @param {{baseUrl?: string, fetchImpl?: typeof fetch}} [options]
 */
export async function publishNtfy(notification, options = {}) {
  if (!TOPIC_RE.test(notification.topic)) throw new Error('invalid ntfy topic');
  if (!notification.messageId) throw new Error('missing notification message id');
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl || fetch;
  const sender = String(notification.sender || 'Unknown sender').trim() || 'Unknown sender';
  const subject = String(notification.subject || '(No subject)').trim() || '(No subject)';
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${notification.topic}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Title': notification.title || `New email from ${sender}`,
      'X-Click': `${COOKIE_ORIGIN}/inbox?open=${encodeURIComponent(notification.messageId)}`,
      'X-Tags': 'email',
      'X-Priority': 'default',
    },
    body: JSON.stringify({ topic: notification.topic, message: subject }),
  });
  if (!response.ok) throw new Error(`ntfy responded ${response.status}`);
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {() => string} [makeTopic]
 */
export async function createNtfySubscription(
  sql,
  userId,
  makeTopic = () => `cookie-${crypto.randomUUID()}`,
) {
  const [existing] = await sql`
    SELECT topic, enabled
    FROM ntfy_subscriptions
    WHERE user_id = ${userId}
  `;
  if (existing) {
    const [enabled] = await sql`
      UPDATE ntfy_subscriptions
      SET enabled = true, updated_at = now()
      WHERE user_id = ${userId}
      RETURNING topic, enabled
    `;
    return {
      topic: enabled?.topic || existing.topic,
      subscribeUrl: `${DEFAULT_BASE_URL}/${enabled?.topic || existing.topic}`,
      enabled: enabled?.enabled ?? true,
    };
  }
  const topic = makeTopic();
  if (!TOPIC_RE.test(topic)) throw new Error('generated invalid ntfy topic');
  const [created] = await sql`
    INSERT INTO ntfy_subscriptions (user_id, topic)
    VALUES (${userId}, ${topic})
    ON CONFLICT (user_id) DO UPDATE SET topic = EXCLUDED.topic, enabled = true, updated_at = now()
    RETURNING topic, enabled
  `;
  if (!created) throw new Error('ntfy subscription was not created');
  return {
    topic: created.topic,
    subscribeUrl: `${DEFAULT_BASE_URL}/${created.topic}`,
    enabled: created.enabled,
  };
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export async function getNtfySubscription(sql, userId) {
  const [subscription] = await sql`
    SELECT topic, enabled
    FROM ntfy_subscriptions
    WHERE user_id = ${userId}
  `;
  if (!subscription) return null;
  return {
    topic: subscription.topic,
    subscribeUrl: `${DEFAULT_BASE_URL}/${subscription.topic}`,
    enabled: subscription.enabled,
  };
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export function disableNtfySubscription(sql, userId) {
  return sql`
    WITH disabled AS (
      UPDATE ntfy_subscriptions
      SET enabled = false, updated_at = now()
      WHERE user_id = ${userId}
      RETURNING user_id
    )
    DELETE FROM ntfy_notification_events event
    USING disabled
    WHERE event.user_id = disabled.user_id AND event.published_at IS NULL
  `;
}

/**
 * Publishes immediately so the user can verify their ntfy subscription
 * without creating a fake email or notification queue record.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{baseUrl?: string, fetchImpl?: typeof fetch}} [options]
 */
export async function sendNtfyTest(sql, userId, options = {}) {
  const [subscription] = await sql`
    SELECT topic
    FROM ntfy_subscriptions
    WHERE user_id = ${userId} AND enabled
  `;
  if (!subscription) throw new Error('ntfy subscription is not enabled');

  await publishNtfy(
    {
      topic: subscription.topic,
      messageId: 'test-notification',
      sender: 'Cookie',
      subject: 'Your ntfy notifications are working.',
      title: 'Cookie notification test',
    },
    options,
  );
  return { sent: true };
}

/**
 * Delivers queued notifications with a short lease-like attempt stamp. A
 * failed delivery remains queued for the next scheduled run, while the
 * attempt cap prevents a permanently invalid topic from retrying forever.
 *
 * @param {import('postgres').Sql} sql
 * @param {{baseUrl?: string, fetchImpl?: typeof fetch, limit?: number}} [options]
 */
export async function deliverPendingNtfy(sql, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20;
  const rows = await sql`
    WITH pending AS (
      SELECT event.event_id
      FROM ntfy_notification_events event
      JOIN ntfy_subscriptions subscription ON subscription.user_id = event.user_id
      JOIN messages message ON message.id = event.message_id
      LEFT JOIN message_ai ai ON ai.message_id = message.id
      WHERE event.published_at IS NULL
        AND event.attempts < 5
        AND subscription.enabled
        AND message.is_unread
        AND NOT message.is_sent
        AND NOT message.is_archived
        AND NOT message.is_deleted
        AND (message.scheduled_for IS NULL OR message.scheduled_for <= now())
        AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
      ORDER BY event.created_at
      LIMIT ${limit}
      FOR UPDATE OF event SKIP LOCKED
    )
    UPDATE ntfy_notification_events event
    SET attempts = event.attempts + 1, last_attempt_at = now()
    FROM pending
    JOIN messages message ON message.id = event.message_id
    JOIN ntfy_subscriptions subscription ON subscription.user_id = event.user_id
    WHERE event.event_id = pending.event_id
    RETURNING event.event_id, event.message_id, subscription.topic,
              message.from_name, message.from_address, message.subject
  `;
  let delivered = 0;
  for (const row of rows) {
    try {
      await publishNtfy(
        {
          topic: row.topic,
          messageId: row.message_id,
          sender: row.from_name || row.from_address,
          subject: row.subject,
        },
        options,
      );
      await sql`
        UPDATE ntfy_notification_events
        SET published_at = now(), last_error = NULL
        WHERE event_id = ${row.event_id}
      `;
      delivered += 1;
    } catch (error) {
      await sql`
        UPDATE ntfy_notification_events
        SET last_error = ${String(error).slice(0, 500)}
        WHERE event_id = ${row.event_id}
      `;
    }
  }
  return { attempted: rows.length, delivered, failed: rows.length - delivered };
}
