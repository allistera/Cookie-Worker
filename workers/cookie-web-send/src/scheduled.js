// Ported from Cookie-Web's api/send.js — the scheduled-send half ("Send
// Later"): queueing, listing, cancelling, and the flush job the
// scheduled-send-flusher cron drives. Behaviorally identical; only the
// (req, res) mutation style becomes returning a Response.

import { retryWithBackoff } from '../../../shared/retry.js';
import {
  claimOutboundEmailQuota,
  deliverMail,
  parseRecipients,
  refundOutboundEmailQuota,
} from './outbound.js';

export const MAX_PENDING_SCHEDULED_SENDS = 50;
// A scheduled send needs enough lead time that it can't fire before the
// composer has even finished closing — matches ScheduleMenu's own minimum.
const MIN_SCHEDULE_LEAD_MS = 60_000;
const FLUSH_BATCH_SIZE = 20;
const FLUSH_CONCURRENCY = 4;
const SCHEDULED_SEND_LEASE_MINUTES = 15;
// After this many failed delivery attempts a scheduled send stops retrying
// and is surfaced to the user as failed, rather than silently retried on
// every flush forever.
const MAX_SCHEDULED_SEND_ATTEMPTS = 5;
// Resolved scheduled_sends rows and expired read receipts otherwise
// accumulate forever; the flush job is the only periodic cron trigger this
// app has, so it doubles as the sweep for both.
const RESOLVED_STATE_RETENTION_DAYS = 30;
const FLUSH_CLAIM_ATTEMPTS = 3;
const FLUSH_CLAIM_BASE_DELAY_MS = 500;
const TRANSIENT_DB_ERROR_CODES = new Set([
  'CONNECT_TIMEOUT',
  '08006',
  '08001',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
]);

// A future ISO timestamp at least MIN_SCHEDULE_LEAD_MS out; anything else
// (missing, unparsable, in the past, or too soon) is rejected. Exported for
// testing.
/** @param {unknown} sendAt */
export function parseScheduledFor(sendAt) {
  const timestamp = Date.parse(String(sendAt ?? ''));
  if (Number.isNaN(timestamp) || timestamp < Date.now() + MIN_SCHEDULE_LEAD_MS) return null;
  return new Date(timestamp).toISOString();
}

// Inserts a pending scheduled_sends row, capped at MAX_PENDING_SCHEDULED_SENDS
// per user so a runaway client can't queue unbounded future sends. Returns
// null if the cap is hit.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{recipients: string[], subject: string, text: string, html: string | null, replyToMessageId: string | null, scheduledFor: string}} send
 */
export async function createScheduledSend(
  sql,
  userId,
  { recipients, subject, text, html, replyToMessageId, scheduledFor },
) {
  // The count-then-insert cap is not safe under READ COMMITTED on its own:
  // two concurrent transactions can both snapshot count = MAX - 1 and both
  // insert. A per-user transaction-scoped advisory lock serializes schedule
  // attempts so the cap actually holds.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}::text)::bigint)`;
    const [row] = await tx`
      INSERT INTO scheduled_sends
        (user_id, to_addresses, subject, body_text, body_html, reply_to_message_id, scheduled_for)
      SELECT ${userId}, ${recipients.join(', ')}, ${subject}, ${text}, ${html ?? null},
             ${replyToMessageId}::uuid, ${scheduledFor}::timestamptz
      WHERE (
        SELECT count(*) FROM scheduled_sends s
        WHERE s.user_id = ${userId} AND s.status = 'pending'
      ) < ${MAX_PENDING_SCHEDULED_SENDS}
      RETURNING id, to_addresses AS "toAddresses", subject, scheduled_for AS "scheduledFor"
    `;
    return row ?? null;
  });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function listScheduledSends(sql, userId) {
  return sql`
    SELECT s.id, s.to_addresses AS "toAddresses", s.subject, s.scheduled_for AS "scheduledFor",
           s.status, s.last_error AS "lastError"
    FROM scheduled_sends s
    WHERE s.user_id = ${userId} AND s.status IN ('pending', 'failed')
    ORDER BY s.scheduled_for ASC
  `;
}

// Only a still-pending row can be canceled — one already claimed by the
// flush job (status 'sending') or already resolved ('sent'/'failed') is
// left alone. Returns the full content so the client can reopen it in the
// composer, mirroring undoPendingSend's immediate-send equivalent.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 */
export async function cancelScheduledSend(sql, userId, id) {
  const [row] = await sql`
    DELETE FROM scheduled_sends s
    WHERE s.id = ${id} AND s.user_id = ${userId} AND s.status = 'pending'
    RETURNING s.id, s.to_addresses AS "toAddresses", s.subject,
              s.body_text AS "text", s.body_html AS "html",
              s.reply_to_message_id AS "replyToMessageId"
  `;
  return row ?? null;
}

// Atomically claims up to `limit` due rows so two overlapping flush calls
// (e.g. a slow run overlapping the next tick) never send the same row twice
// — FOR UPDATE SKIP LOCKED lets a concurrent call skip rows this one already
// has locked instead of blocking on them.
/**
 * @param {import('postgres').Sql} sql
 * @param {number} limit
 */
async function claimDueScheduledSends(sql, limit) {
  return sql`
    UPDATE scheduled_sends s
    SET status = 'sending', claimed_at = now()
    FROM (
      SELECT id FROM scheduled_sends
      WHERE (status = 'pending' AND scheduled_for <= now())
         OR (status = 'sending'
             AND claimed_at < now() - make_interval(mins => ${SCHEDULED_SEND_LEASE_MINUTES}))
      ORDER BY scheduled_for
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ) due
    WHERE s.id = due.id
    RETURNING s.id, s.user_id, s.to_addresses AS "toAddresses", s.subject,
              s.body_text AS "text", s.body_html AS "html",
              s.reply_to_message_id AS "replyToMessageId", s.attempts
  `;
}

/** @param {unknown} err */
function isTransientDbConnectionError(err) {
  const code = /** @type {{code?: string}} */ (err)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return (
    TRANSIENT_DB_ERROR_CODES.has(/** @type {string} */ (code)) ||
    /CONNECT_TIMEOUT|Failed to connect to database|ENETUNREACH/i.test(message)
  );
}

/**
 * @param {import('postgres').Sql} sql
 * @param {number} limit
 */
async function claimDueScheduledSendsWithRetry(sql, limit) {
  return retryWithBackoff(() => claimDueScheduledSends(sql, limit), {
    attempts: FLUSH_CLAIM_ATTEMPTS,
    baseDelayMs: FLUSH_CLAIM_BASE_DELAY_MS,
    isRetryable: isTransientDbConnectionError,
  });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} id
 * @param {string} error
 * @param {number | null} [attempts]
 */
async function markScheduledSendFailed(sql, id, error, attempts = null) {
  await sql`
    UPDATE scheduled_sends
    SET status = 'failed', last_error = ${error},
        attempts = COALESCE(${attempts}, attempts), claimed_at = NULL
    WHERE id = ${id}
  `;
}

// Delivers one claimed row. Never leaves a row claimed ('sending' status)
// without resolving it to 'pending' (retry), 'sent', or 'failed'. Reports the
// sent copy's id alongside the outcome, but only when this attempt is the one
// that inserted it, so handleFlush can index the batch in one go and a replay
// (an expired lease redelivered under the same idempotency key) indexes
// nothing new.
/**
 * @param {import('postgres').Sql} sql
 * @param {any} row
 * @param {import('./outbound.js').SendServices} services
 * @returns {Promise<{status: string, storedMessageUuid: string | null}>}
 */
export async function deliverScheduledSend(sql, row, services) {
  const [owner] = await sql`SELECT 1 AS "exists" FROM users WHERE id = ${row.user_id}`;
  if (!owner) {
    await markScheduledSendFailed(sql, row.id, 'Owning user no longer exists');
    return { status: 'failed', storedMessageUuid: null };
  }

  const quota = await claimOutboundEmailQuota(sql, row.user_id);
  if (!quota.authorized) {
    await markScheduledSendFailed(sql, row.id, 'Mailbox access is not provisioned');
    return { status: 'failed', storedMessageUuid: null };
  }
  if (!quota.quota_claimed) {
    // Rate-limited, not the message's fault — leave it pending for the next
    // flush instead of spending a retry attempt.
    await sql`UPDATE scheduled_sends SET status = 'pending', claimed_at = NULL WHERE id = ${row.id}`;
    return { status: 'retried', storedMessageUuid: null };
  }

  const recipients = parseRecipients(row.toAddresses);
  let delivered;
  try {
    delivered = await deliverMail(
      sql,
      row.user_id,
      {
        recipients,
        subject: row.subject,
        text: row.text,
        html: row.html,
        replyToMessageId: row.replyToMessageId,
        idempotencyKey: `scheduled-send/${row.id}`,
        // The receipt URL is part of the provider payload, so it must remain
        // stable when an expired lease retries with the same idempotency key.
        readReceiptToken: row.id,
      },
      services,
    );
  } catch (err) {
    const attempts = row.attempts + 1;
    const message = /** @type {Error} */ (err).message;
    console.error(`scheduled send ${row.id} delivery failed (attempt ${attempts}):`, message);
    // Nothing went out, so give the minute's quota back instead of letting a
    // provider outage consume the user's allowance through retries.
    await refundOutboundEmailQuota(sql, row.user_id);
    if (attempts >= MAX_SCHEDULED_SEND_ATTEMPTS) {
      await markScheduledSendFailed(sql, row.id, message, attempts);
      return { status: 'failed', storedMessageUuid: null };
    }
    await sql`
      UPDATE scheduled_sends
      SET status = 'pending', attempts = ${attempts}, last_error = ${message}, claimed_at = NULL
      WHERE id = ${row.id}
    `;
    return { status: 'retried', storedMessageUuid: null };
  }

  // Independent of how the bookkeeping below goes: the copy is in Postgres, so
  // it belongs in the index even if the row cannot be marked sent.
  const storedMessageUuid = delivered.inserted ? delivered.messageUuid : null;
  try {
    await sql`
      UPDATE scheduled_sends
      SET status = 'sent', sent_at = now(), sent_message_id = ${delivered.messageUuid},
          claimed_at = NULL, last_error = NULL
      WHERE id = ${row.id}
    `;
    return { status: 'sent', storedMessageUuid };
  } catch (err) {
    // Delivery is irreversible and succeeded. Leave the row leased as
    // `sending`: a later flush can safely reclaim it because the provider call
    // uses the stable scheduled-send idempotency key.
    console.error(
      `scheduled send ${row.id} delivered but could not be marked sent:`,
      /** @type {Error} */ (err).message,
    );
    return { status: 'unconfirmed', storedMessageUuid };
  }
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R>} operation
 */
async function mapWithConcurrency(items, concurrency, operation) {
  /** @type {R[]} */
  const results = Array.from({ length: items.length });
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Best-effort; a sweep failure must never block the flush job's actual
// purpose of sending due mail.
/** @param {import('postgres').Sql} sql */
async function sweepResolvedState(sql) {
  try {
    await sql`
      DELETE FROM scheduled_sends
      WHERE status IN ('sent', 'failed')
        AND COALESCE(sent_at, created_at) < now() - make_interval(days => ${RESOLVED_STATE_RETENTION_DAYS})
    `;
    await sql`DELETE FROM message_read_receipts WHERE expires_at < now()`;
  } catch (err) {
    console.error('resolved-state sweep failed:', /** @type {Error} */ (err).message);
  }
}

// POST /send/flush — called on a schedule by the scheduled-send-flusher
// Worker cron over a service binding (never by the browser app),
// bearer-authenticated with a shared secret because this route is also
// publicly routable. Claims and delivers due scheduled sends in small
// batches so one slow invocation doesn't run unbounded.
/**
 * @param {import('postgres').Sql} sql
 * @param {import('./outbound.js').SendServices} services
 */
export async function handleFlush(sql, services) {
  try {
    const claimed = await claimDueScheduledSendsWithRetry(sql, FLUSH_BATCH_SIZE);
    const results = await mapWithConcurrency(claimed, FLUSH_CONCURRENCY, (row) =>
      deliverScheduledSend(sql, row, services),
    );
    await sweepResolvedState(sql);
    // One sync for the whole batch, not one per delivered row: a full flush
    // would otherwise fire FLUSH_BATCH_SIZE separate Postgres/Meilisearch
    // round trips for what is a single addDocuments call.
    services.indexSentMessages(
      results.flatMap((result) => (result.storedMessageUuid ? [result.storedMessageUuid] : [])),
    );
    return Response.json({
      claimed: claimed.length,
      sent: results.filter((result) => result.status === 'sent').length,
      retried: results.filter((result) => result.status === 'retried').length,
      failed: results.filter((result) => result.status === 'failed').length,
      unconfirmed: results.filter((result) => result.status === 'unconfirmed').length,
    });
  } catch (err) {
    console.error('POST /send/flush failed:', err);
    return Response.json({ error: 'Flush failed' }, { status: 500 });
  }
}
