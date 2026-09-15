export const DEFAULT_BASE_URL = 'https://ntfy.allisterantosik.com';
const TOPIC_RE = /^[A-Za-z0-9_-]{8,128}$/;
const COOKIE_ORIGIN = 'https://mail.infinitywave.online';
const MAX_RETRY_DELAY_MS = 5000;
const MAX_BODY_BYTES = 3500;

export class NtfyPublishError extends Error {
  /** @param {number} status @param {number | null} retryAfterSeconds */
  constructor(status, retryAfterSeconds = null) {
    super(`ntfy responded ${status}`);
    this.name = 'NtfyPublishError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** @param {Response} response */
function retryAfterSeconds(response) {
  const value = response.headers.get('Retry-After');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** @param {string} text */
function truncateBody(text) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= MAX_BODY_BYTES) return text;

  let truncated = '';
  let bytes = 0;
  const suffix = '…';
  const suffixBytes = encoder.encode(suffix).length;
  for (const character of text) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes + suffixBytes > MAX_BODY_BYTES) break;
    truncated += character;
    bytes += characterBytes;
  }
  return `${truncated}${suffix}`;
}

/**
 * @param {{topic: string, messageId: string, subject?: string | null, bodyText?: string | null, title?: string | null}} notification
 * @param {{baseUrl?: string, fetchImpl?: typeof fetch, maxAttempts?: number, sleepImpl?: (milliseconds: number) => Promise<void>}} [options]
 */
export async function publishNtfy(notification, options = {}) {
  if (!TOPIC_RE.test(notification.topic)) throw new Error('invalid ntfy topic');
  if (!notification.messageId) throw new Error('missing notification message id');
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl || fetch;
  const sleepImpl = options.sleepImpl || sleep;
  const maxAttempts =
    typeof options.maxAttempts === 'number' && Number.isInteger(options.maxAttempts)
      ? Math.max(1, options.maxAttempts)
      : 3;
  const subject = String(notification.subject || '(No subject)').trim() || '(No subject)';
  const plainText =
    String(notification.bodyText || '').trim() || 'No plain-text content available.';
  const body = truncateBody(plainText);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/${notification.topic}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Title': notification.title || subject,
        'X-Click': `${COOKIE_ORIGIN}/inbox?open=${encodeURIComponent(notification.messageId)}`,
        'X-Tags': 'email',
        'X-Priority': 'default',
      },
      body,
    });
    if (response.ok) return;

    const retryAfter = retryAfterSeconds(response);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxAttempts) {
      throw new NtfyPublishError(response.status, retryAfter);
    }
    const fallbackDelay = 250 * 2 ** (attempt - 1);
    const delay = retryAfter === null ? fallbackDelay : retryAfter * 1000;
    await sleepImpl(Math.min(delay, MAX_RETRY_DELAY_MS));
  }
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{baseUrl?: string, makeTopic?: () => string}} [options]
 */
export async function createNtfySubscription(sql, userId, options = {}) {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const makeTopic = options.makeTopic || (() => `cookie-${crypto.randomUUID()}`);
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
      subscribeUrl: `${baseUrl}/${enabled?.topic || existing.topic}`,
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
    subscribeUrl: `${baseUrl}/${created.topic}`,
    enabled: created.enabled,
  };
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {{baseUrl?: string}} [options] */
export async function getNtfySubscription(sql, userId, options = {}) {
  const [subscription] = await sql`
    SELECT topic, enabled
    FROM ntfy_subscriptions
    WHERE user_id = ${userId}
  `;
  if (!subscription) return null;
  return {
    topic: subscription.topic,
    subscribeUrl: `${(options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/${subscription.topic}`,
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
      subject: 'Your ntfy notifications are working.',
      bodyText: 'Your ntfy notifications are working.',
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
      SELECT event.event_id, event.message_id, subscription.topic,
             message.subject, message.body_text
      FROM ntfy_notification_events event
      JOIN ntfy_subscriptions subscription ON subscription.user_id = event.user_id
      JOIN messages message
        ON message.id = event.message_id AND message.user_id = event.user_id
      LEFT JOIN message_ai ai ON ai.message_id = message.id
      LEFT JOIN email_categories category
        ON category.id = message.category_id AND category.user_id = message.user_id
      WHERE event.published_at IS NULL
        AND event.attempts < 5
        AND subscription.enabled
        AND message.is_unread
        AND NOT message.is_sent
        AND NOT message.is_archived
        AND NOT message.is_deleted
        AND (message.scheduled_for IS NULL OR message.scheduled_for <= now())
        AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
        AND (ai.status IS DISTINCT FROM 'pending'
          OR ai.updated_at <= now() - interval '5 minutes')
        AND (message.category_id IS NULL OR category.notifications_enabled)
      ORDER BY event.created_at
      LIMIT ${limit}
      FOR UPDATE OF event SKIP LOCKED
    )
    UPDATE ntfy_notification_events event
    SET attempts = event.attempts + 1, last_attempt_at = now()
    FROM pending
    WHERE event.event_id = pending.event_id
    RETURNING pending.event_id, pending.message_id, pending.topic,
              pending.subject, pending.body_text
  `;
  let delivered = 0;
  for (const row of rows) {
    try {
      await publishNtfy(
        {
          topic: row.topic,
          messageId: row.message_id,
          subject: row.subject,
          bodyText: row.body_text,
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
