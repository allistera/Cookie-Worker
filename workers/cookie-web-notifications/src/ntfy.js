import { fetchWithTimeout } from '../../../shared/fetch.js';
import { decryptToken, encryptToken } from '../../../shared/token-crypto.js';

export const DEFAULT_BASE_URL = 'https://ntfy.allisterantosik.com';
// ntfy's own topic rule: letters, digits, underscore and hyphen, at most 64.
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SERVER_URL_LENGTH = 200;
const MAX_TOKEN_LENGTH = 200;
const TOKEN_HINT_LENGTH = 4;
const COOKIE_ORIGIN = 'https://mail.infinitywave.online';
// Cookie-iOS registers this scheme (its bundle id) and opens
// <scheme>://inbox?open=<message id> on the email — see InboxDeepLink.swift.
const IOS_APP_SCHEME = 'com.cookie.ios';
const MAX_RETRY_DELAY_MS = 5000;
// One publish attempt; a hung ntfy server must not stall the whole batch.
export const NTFY_FETCH_TIMEOUT_MS = 10_000;
// Publishes in flight at once while draining a claimed batch.
export const DELIVERY_CONCURRENCY = 4;
// Comfortably above what truncateBody keeps (MAX_BODY_BYTES), so the cut is
// still made there but a huge body is never pulled out of Postgres for it.
const BODY_SELECT_CHARS = 4000;
const MAX_BODY_BYTES = 3500;
// RFC 2047 caps an encoded word at 75 characters: "=?UTF-8?B?" + "?=" is 12,
// and 45 bytes of base64 is 60, leaving the word at 72.
const ENCODED_WORD_MAX_BYTES = 45;

class NotificationSuppressedError extends Error {}

export class NtfyPublishError extends Error {
  /** @param {number} status @param {number | null} retryAfterSeconds */
  constructor(status, retryAfterSeconds = null) {
    super(`ntfy responded ${status}`);
    this.name = 'NtfyPublishError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A server URL, topic or token Settings sent that cannot be used. */
export class NtfySettingsError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'NtfySettingsError';
    this.code = code;
  }
}

/**
 * The ntfy server Settings typed in, as the base of every publish URL: https
 * only (a token travels in the Authorization header), no credentials, query
 * or fragment, and no trailing slash so the topic can be appended.
 *
 * @param {unknown} value
 */
export function normalizeServerUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > MAX_SERVER_URL_LENGTH) {
    throw new NtfySettingsError(
      'invalid_server_url',
      'Enter the https:// address of an ntfy server.',
    );
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new NtfySettingsError(
      'invalid_server_url',
      'Enter the https:// address of an ntfy server.',
    );
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new NtfySettingsError(
      'invalid_server_url',
      'Enter the https:// address of an ntfy server.',
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** @param {unknown} value */
export function normalizeTopic(value) {
  const topic = String(value ?? '').trim();
  if (!TOPIC_RE.test(topic)) {
    throw new NtfySettingsError(
      'invalid_topic',
      'A topic is 1 to 64 letters, digits, hyphens or underscores.',
    );
  }
  return topic;
}

/** @param {unknown} value */
function normalizeAccessToken(value) {
  const token = String(value ?? '').trim();
  if (!token || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    throw new NtfySettingsError('invalid_access_token', 'That access token cannot be used.');
  }
  return token;
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
 * Makes a value safe for an HTTP header. Header values must be ByteStrings,
 * so fetch throws a TypeError on any character above U+00FF (an emoji, an
 * em dash, CJK) and the push is never sent; Latin-1 characters get through
 * but reach ntfy as invalid UTF-8. Anything beyond printable ASCII is sent as
 * RFC 2047 encoded words instead, which ntfy decodes for X-Title (v2.4.0+).
 * Words split on character boundaries, never inside a UTF-8 sequence, and
 * ntfy ignores the whitespace between adjacent words when decoding.
 *
 * @param {string} value
 */
export function encodeHeaderValue(value) {
  // Control characters (a folded subject's CR/LF) are never valid in a header.
  const text = value.replace(/\p{Cc}+/gu, ' ');
  if (/^[\x20-\x7e]*$/.test(text)) return text;

  const encoder = new TextEncoder();
  /** @type {number[][]} */
  const words = [[]];
  for (const character of text) {
    const bytes = encoder.encode(character);
    if (words[words.length - 1].length + bytes.length > ENCODED_WORD_MAX_BYTES) words.push([]);
    words[words.length - 1].push(...bytes);
  }
  return words.map((bytes) => `=?UTF-8?B?${btoa(String.fromCharCode(...bytes))}?=`).join(' ');
}

/**
 * @param {{topic: string, messageId: string, subject?: string | null, bodyText?: string | null, title?: string | null, accessToken?: string | null}} notification
 * @param {{baseUrl?: string, fetchImpl?: typeof fetch, maxAttempts?: number, sleepImpl?: (milliseconds: number) => Promise<void>, canPublish?: () => Promise<boolean>}} [options]
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
    // Check again before every external attempt, including retries after a wait.
    if (options.canPublish && !(await options.canPublish()))
      throw new NotificationSuppressedError();
    const response = await fetchWithTimeout(
      `${baseUrl.replace(/\/$/, '')}/${notification.topic}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          // ntfy access tokens (ntfy.sh reserved topics, self-hosted servers
          // with auth) are sent as a bearer token; basic auth is not offered.
          ...(notification.accessToken
            ? { Authorization: `Bearer ${notification.accessToken}` }
            : {}),
          'X-Title': encodeHeaderValue(notification.title || subject),
          'X-Click': `${COOKIE_ORIGIN}/inbox?open=${encodeURIComponent(notification.messageId)}`,
          // Tapping the notification opens the web inbox (works for every ntfy
          // client); this button opens the same email in the iOS app instead.
          'X-Actions': `view, Open in Cookie app, ${IOS_APP_SCHEME}://inbox?open=${encodeURIComponent(notification.messageId)}, clear=true`,
          'X-Tags': 'email',
          'X-Priority': 'default',
        },
        body,
      },
      async (published) => published,
      NTFY_FETCH_TIMEOUT_MS,
      fetchImpl,
    );
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
 * @typedef {{serverUrl: string, topic: string, enabled: boolean, tokenHint: string, accessTokenEncrypted: string | null}} NtfySubscriptionRow
 */

/** @param {any} row @returns {NtfySubscriptionRow} */
function subscriptionFromRow(row) {
  return {
    serverUrl: String(row.server_url),
    topic: String(row.topic),
    enabled: row.enabled === true,
    tokenHint: String(row.token_hint ?? ''),
    accessTokenEncrypted: row.access_token_encrypted ?? null,
  };
}

/**
 * The wire shape Settings renders. The token itself never leaves the Worker;
 * only its last characters do. `defaultServerUrl` prefills the form for a
 * user who has not set ntfy up, and `tokensSupported` tells Settings whether
 * this deployment can hold an access token at all.
 *
 * @param {NtfySubscriptionRow | null} subscription
 * @param {{baseUrl?: string, tokenKey?: string}} options
 */
export function publicNtfySettings(subscription, options) {
  const defaultServerUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  return {
    enabled: subscription?.enabled ?? false,
    defaultServerUrl,
    tokensSupported: Boolean(options.tokenKey),
    ...(subscription
      ? {
          serverUrl: subscription.serverUrl,
          topic: subscription.topic,
          subscribeUrl: `${subscription.serverUrl}/${subscription.topic}`,
          tokenHint: subscription.tokenHint,
        }
      : {}),
  };
}

/** @param {import('postgres').Sql} sql @param {string} userId */
async function loadSubscription(sql, userId) {
  const [row] = await sql`
    SELECT server_url, topic, enabled, token_hint, access_token_encrypted
    FROM ntfy_subscriptions
    WHERE user_id = ${userId}
  `;
  return row ? subscriptionFromRow(row) : null;
}

/**
 * Stores the server, topic and (optionally) access token Settings sent, and
 * turns delivery on. `accessToken` left out keeps the stored token, `null`
 * removes it, a string replaces it. A token can only be kept when the Worker
 * holds the encryption key; the route reports that as not configured.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{serverUrl?: unknown, topic?: unknown, accessToken?: unknown}} input
 * @param {{baseUrl?: string, tokenKey?: string}} options
 */
export async function saveNtfySubscription(sql, userId, input, options) {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const topic = normalizeTopic(input.topic);
  const hasToken = Object.hasOwn(input, 'accessToken');
  /** @type {string | null} */
  let accessTokenEncrypted = null;
  let tokenHint = '';
  if (hasToken && input.accessToken !== null) {
    if (!options.tokenKey) {
      throw new NtfySettingsError(
        'tokens_not_configured',
        'Access tokens are not set up on this Cookie deployment.',
      );
    }
    const token = normalizeAccessToken(input.accessToken);
    accessTokenEncrypted = await encryptToken(token, options.tokenKey);
    tokenHint = token.slice(-TOKEN_HINT_LENGTH);
  }
  let row;
  try {
    // Two Cookie accounts on one server must not share a topic, or each
    // would receive the other's mail; the unique index on (server_url,
    // topic) enforces that and surfaces here as 23505.
    [row] = hasToken
      ? await sql`
          INSERT INTO ntfy_subscriptions
            (user_id, server_url, topic, enabled, access_token_encrypted, token_hint)
          VALUES
            (${userId}, ${serverUrl}, ${topic}, true, ${accessTokenEncrypted}, ${tokenHint})
          ON CONFLICT (user_id) DO UPDATE SET
            server_url = EXCLUDED.server_url,
            topic = EXCLUDED.topic,
            enabled = true,
            access_token_encrypted = EXCLUDED.access_token_encrypted,
            token_hint = EXCLUDED.token_hint,
            updated_at = now()
          RETURNING server_url, topic, enabled, token_hint, access_token_encrypted
        `
      : await sql`
          INSERT INTO ntfy_subscriptions (user_id, server_url, topic, enabled)
          VALUES (${userId}, ${serverUrl}, ${topic}, true)
          ON CONFLICT (user_id) DO UPDATE SET
            server_url = EXCLUDED.server_url,
            topic = EXCLUDED.topic,
            enabled = true,
            updated_at = now()
          RETURNING server_url, topic, enabled, token_hint, access_token_encrypted
        `;
  } catch (error) {
    if (/** @type {{code?: string}} */ (error)?.code === '23505') {
      throw new NtfySettingsError(
        'topic_taken',
        'Another Cookie account already uses that topic on this server.',
      );
    }
    throw error;
  }
  if (!row) throw new Error('ntfy subscription was not saved');
  return publicNtfySettings(subscriptionFromRow(row), options);
}

/**
 * Turns delivery on for a user who never chose a server or topic, with a
 * random topic on the default server (the setup Settings offered before the
 * form existed). An existing subscription is simply re-enabled as it stands.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{baseUrl?: string, tokenKey?: string, makeTopic?: () => string}} [options]
 */
export async function createNtfySubscription(sql, userId, options = {}) {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const makeTopic = options.makeTopic || (() => `cookie-${crypto.randomUUID()}`);
  const [existing] = await sql`
    UPDATE ntfy_subscriptions
    SET enabled = true, updated_at = now()
    WHERE user_id = ${userId}
    RETURNING server_url, topic, enabled, token_hint, access_token_encrypted
  `;
  if (existing) return publicNtfySettings(subscriptionFromRow(existing), options);
  const topic = makeTopic();
  if (!TOPIC_RE.test(topic)) throw new Error('generated invalid ntfy topic');
  const [created] = await sql`
    INSERT INTO ntfy_subscriptions (user_id, server_url, topic)
    VALUES (${userId}, ${baseUrl}, ${topic})
    ON CONFLICT (user_id) DO UPDATE SET enabled = true, updated_at = now()
    RETURNING server_url, topic, enabled, token_hint, access_token_encrypted
  `;
  if (!created) throw new Error('ntfy subscription was not created');
  return publicNtfySettings(subscriptionFromRow(created), options);
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {{baseUrl?: string, tokenKey?: string}} [options] */
export async function getNtfySubscription(sql, userId, options = {}) {
  return publicNtfySettings(await loadSubscription(sql, userId), options);
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
 * The stored access token, or null when the subscription has none. A token
 * stored under a key the Worker no longer holds cannot be used, so that
 * publish fails (and is recorded) rather than going out unauthenticated.
 *
 * @param {string | null} accessTokenEncrypted
 * @param {string | undefined} tokenKey
 */
async function accessTokenFor(accessTokenEncrypted, tokenKey) {
  if (!accessTokenEncrypted) return null;
  if (!tokenKey) throw new Error('ntfy access token cannot be decrypted: no encryption key');
  return decryptToken(accessTokenEncrypted, tokenKey);
}

/**
 * Publishes immediately so the user can verify their ntfy subscription
 * without creating a fake email or notification queue record.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{baseUrl?: string, tokenKey?: string, fetchImpl?: typeof fetch}} [options]
 */
export async function sendNtfyTest(sql, userId, options = {}) {
  const [subscription] = await sql`
    SELECT server_url, topic, access_token_encrypted
    FROM ntfy_subscriptions
    WHERE user_id = ${userId} AND enabled
  `;
  if (!subscription) throw new Error('ntfy subscription is not enabled');

  await publishNtfy(
    {
      topic: subscription.topic,
      accessToken: await accessTokenFor(subscription.access_token_encrypted, options.tokenKey),
      messageId: 'test-notification',
      subject: 'Your ntfy notifications are working.',
      bodyText: 'Your ntfy notifications are working.',
      title: 'Cookie notification test',
    },
    { ...options, baseUrl: subscription.server_url },
  );
  return { sent: true };
}

/**
 * Delivers queued notifications. Claiming a row stamps last_attempt_at, and a
 * row is only claimable again once its backoff has elapsed: 2, 4, 8, 16, 32
 * minutes, then hourly. The shortest wait doubles as a lease, so a run that
 * overlaps the next every-minute cron tick cannot publish the same row twice
 * (FOR UPDATE SKIP LOCKED only holds for the claiming statement). A failed
 * delivery keeps retrying through an ntfy outage until the event is a day
 * old, matching mail-app-ingest's purge of day-old notification events.
 * A slow run can still outlive that lease, so each claim remembers its attempt
 * number and only publishes or records a result while the row still carries
 * it; a row a later tick has reclaimed is skipped and left to that tick.
 *
 * @param {import('postgres').Sql} sql
 * @param {{baseUrl?: string, tokenKey?: string, fetchImpl?: typeof fetch, limit?: number}} [options]
 */
export async function deliverPendingNtfy(sql, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 20;
  const rows = await sql`
    WITH pending AS (
      SELECT event.event_id, event.message_id, subscription.topic,
             subscription.server_url, subscription.access_token_encrypted,
             message.subject, left(message.body_text, ${BODY_SELECT_CHARS}) AS body_text
      FROM ntfy_notification_events event
      JOIN ntfy_subscriptions subscription ON subscription.user_id = event.user_id
      JOIN messages message
        ON message.id = event.message_id AND message.user_id = event.user_id
      LEFT JOIN message_ai ai ON ai.message_id = message.id
      LEFT JOIN email_categories category
        ON category.id = message.category_id AND category.user_id = message.user_id
      WHERE event.published_at IS NULL
        AND event.created_at > now() - interval '24 hours'
        AND (event.last_attempt_at IS NULL
          OR event.last_attempt_at <= now()
            - LEAST(interval '1 hour', interval '1 minute' * power(2, event.attempts)))
        AND subscription.enabled
        AND message.is_unread
        AND NOT message.is_sent
        AND NOT message.is_archived
        AND NOT message.is_deleted
        AND message.screening_status = 'allowed'
        AND NOT EXISTS (
          SELECT 1 FROM effective_sender_decision(message.user_id, message.from_address) sender
          WHERE sender.decision = 'blocked'
        )
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
              pending.server_url, pending.access_token_encrypted,
              pending.subject, pending.body_text, event.attempts
  `;
  let delivered = 0;
  let suppressed = 0;
  let skipped = 0;
  /** @param {any} row */
  const deliver = async (row) => {
    let claimLost = false;
    try {
      await publishNtfy(
        {
          topic: row.topic,
          accessToken: await accessTokenFor(row.access_token_encrypted, options.tokenKey),
          messageId: row.message_id,
          subject: row.subject,
          bodyText: row.body_text,
        },
        {
          ...options,
          // Rows written before each user chose a server carry the default.
          baseUrl: row.server_url || options.baseUrl,
          canPublish: async () => {
            // The message can be read, archived or deleted, the sender blocked,
            // or notifications switched off while a publish waits to retry.
            const [event] = await sql`SELECT event.attempts,
                (subscription.enabled
                  AND message.is_unread
                  AND NOT message.is_archived
                  AND NOT message.is_deleted
                  AND message.screening_status = 'allowed'
                  AND NOT EXISTS (SELECT 1 FROM effective_sender_decision(message.user_id, message.from_address) sender
          WHERE sender.decision = 'blocked')) AS eligible
              FROM ntfy_notification_events event
              JOIN messages message ON message.id = event.message_id AND message.user_id = event.user_id
              LEFT JOIN ntfy_subscriptions subscription ON subscription.user_id = event.user_id
              WHERE event.event_id = ${row.event_id} AND event.published_at IS NULL`;
            if (event && Number(event.attempts) !== Number(row.attempts)) {
              claimLost = true;
              return false;
            }
            return Boolean(event?.eligible);
          },
        },
      );
      await sql`
        UPDATE ntfy_notification_events
        SET published_at = now(), last_error = NULL
        WHERE event_id = ${row.event_id} AND attempts = ${row.attempts}
      `;
      delivered += 1;
    } catch (error) {
      if (claimLost) {
        skipped += 1;
        return;
      }
      if (error instanceof NotificationSuppressedError) {
        suppressed += 1;
        await sql`DELETE FROM ntfy_notification_events WHERE event_id = ${row.event_id} AND published_at IS NULL`;
        return;
      }
      await sql`
        UPDATE ntfy_notification_events
        SET last_error = ${String(error).slice(0, 500)}
        WHERE event_id = ${row.event_id} AND attempts = ${row.attempts}
      `;
    }
  };
  // A few publishes at a time: one after another, a batch of slow or retrying
  // publishes could outlast the next tick, and every row at once would hammer
  // ntfy. Each row's outcome is independent, so order does not matter.
  let next = 0;
  const lanes = Array.from({ length: Math.min(DELIVERY_CONCURRENCY, rows.length) }, async () => {
    while (next < rows.length) await deliver(rows[next++]);
  });
  await Promise.all(lanes);
  return {
    attempted: rows.length,
    delivered,
    failed: rows.length - delivered - suppressed - skipped,
    ...(suppressed ? { suppressed } : {}),
    ...(skipped ? { skipped } : {}),
  };
}
