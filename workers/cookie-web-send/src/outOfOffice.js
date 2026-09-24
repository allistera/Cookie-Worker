import {
  autoReplySuppression,
  hasUnsafeControls,
  lockOutOfOfficeDispatch,
  normaliseAddress,
  outOfOfficeSettings,
} from '../../../shared/outOfOffice.js';
import { claimOutboundEmailQuota, configuredEmailFrom, storeSentMessage } from './outbound.js';
import { AUTO_REPLY_PROVIDER_TIMEOUT_MS, sendAutoReply } from './autoReplyProvider.js';

export const AUTO_REPLY_SCAN_LIMIT = 25;
export const AUTO_REPLY_SEND_LIMIT = 10;
export const AUTO_REPLY_FLUSH_BUDGET_MS = 20_000;
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 12;

/** @param {any} settings @param {any} message @param {string} from */
export function autoReplyPayload(settings, message, from) {
  const headers = {
    'Auto-Submitted': 'auto-replied',
    'X-Auto-Response-Suppress': 'All',
    Precedence: 'bulk',
  };
  // A malformed/overlong untrusted Message-ID is never put in an outbound header.
  if (
    /^<[^<>\s]{1,900}>$/.test(message.message_id ?? '') &&
    !hasUnsafeControls(message.message_id)
  ) {
    headers['In-Reply-To'] = message.message_id;
    headers.References = message.message_id;
  }
  return {
    from,
    to: [normaliseAddress(message.envelope_from)],
    subject: settings.subject,
    text: settings.text,
    headers,
  };
}

/** @param {import('postgres').Sql} sql @param {string} from @param {number} [deadline] */
export async function enqueueAutoReplies(sql, from, deadline = Infinity) {
  // No AI row, pending/failed classification, or spam verdict means no reply.
  // The arrival snapshot is never backfilled; current prefs alone cannot prove
  // that the owner had enabled the responder when a message was received.
  const arrivals = await sql`
    SELECT m.id, m.user_id, m.created_at, m.message_id, m.from_address, m.envelope_from,
           m.envelope_to, m.recipients, m.headers, m.is_sent, m.is_deleted, m.auto_reply_suppressed,
           m.out_of_office_revision, u.email AS owner_email, u.prefs -> 'outOfOffice' AS settings,
           ai.status AS ai_status, ai.spam_verdict, clock_timestamp() AS clock
    FROM messages m JOIN users u ON u.id = m.user_id
    JOIN message_ai ai ON ai.message_id = m.id
    WHERE NOT m.is_sent AND m.out_of_office_revision IS NOT NULL
      AND u.prefs -> 'outOfOffice' ->> 'enabled' = 'true'
      AND u.prefs -> 'outOfOffice' ->> 'revision' = m.out_of_office_revision::text
      AND ai.status = 'completed' AND ai.spam_verdict = 'inbox'
      AND NOT EXISTS (SELECT 1 FROM out_of_office_deliveries d WHERE d.user_id = m.user_id AND d.message_id = m.id)
    ORDER BY m.created_at, m.id LIMIT ${AUTO_REPLY_SCAN_LIMIT}
  `;
  for (const message of arrivals) {
    if (Date.now() >= deadline) break;
    const settings = outOfOfficeSettings(message.settings);
    const reason = autoReplySuppression(message, settings, from, message.clock);
    const payload = autoReplyPayload(settings, message, from);
    await sql`INSERT INTO out_of_office_deliveries
      (user_id, message_id, settings_revision, recipient, payload, status, reason)
      VALUES (${message.user_id}, ${message.id}, ${settings.revision}, ${normaliseAddress(message.envelope_from) ?? ''},
        ${sql.json(payload)}, ${reason ? 'suppressed' : 'pending'}, ${reason})
      ON CONFLICT (user_id, message_id) DO NOTHING`;
  }
  return arrivals.length;
}

/** @param {any} tx @param {string} userId */
async function lockOwner(tx, userId) {
  // Only the short claim transaction uses ingest's lock and users FOR UPDATE.
  // Its caller already holds the responder lock. Neither may span provider I/O.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
  const [owner] = await tx`SELECT id, email, auth0_sub, prefs -> 'outOfOffice' AS settings
    FROM users WHERE id = ${userId} FOR UPDATE`;
  return owner;
}

/** @param {any} tx @param {any} row @param {string} status @param {string} reason */
async function finish(tx, row, status, reason) {
  await tx`UPDATE out_of_office_deliveries SET status = ${status}, reason = ${reason},
    claimed_at = NULL, claim_token = NULL WHERE id = ${row.id} AND user_id = ${row.user_id}`;
  if (status === 'uncertain')
    await tx`UPDATE out_of_office_senders SET blocked = true
      WHERE user_id = ${row.user_id} AND delivery_id = ${row.id}`;
  return status;
}

/** @param {any} tx @param {any} row @param {any} owner @param {string} from @param {Date} now */
async function currentSuppression(tx, row, owner, from, now) {
  if (!owner?.auth0_sub) return 'owner_unprovisioned';
  if (row.payload.from !== from) return 'sender_identity_changed';
  const [message] = await tx`
    SELECT m.id, m.created_at, m.message_id, m.from_address, m.envelope_from,
           m.envelope_to, m.recipients, m.headers, m.is_sent, m.is_deleted, m.auto_reply_suppressed,
           m.out_of_office_revision, ai.status AS ai_status, ai.spam_verdict
    FROM messages m JOIN message_ai ai ON ai.message_id = m.id
    WHERE m.id = ${row.message_id} AND m.user_id = ${row.user_id}
    FOR UPDATE OF m, ai NOWAIT
  `;
  if (!message) return 'message_missing';
  return autoReplySuppression(
    { ...message, owner_email: owner.email },
    outOfOfficeSettings(owner.settings),
    from,
    now,
  );
}

/**
 * Commit the immutable attempt identity, reservation and retry deadline BEFORE
 * touching the provider. A crash then leaves a reclaimable lease, never a fresh
 * logical send. Reserve existing outbound quota once; no ambiguous refund.
 * @param {import('postgres').Sql} sql @param {any} candidate @param {string} from
 */
export async function claimAutoReply(sql, candidate, from) {
  return sql.begin(async (tx) => {
    await lockOutOfOfficeDispatch(tx, candidate.user_id);
    const owner = await lockOwner(tx, candidate.user_id);
    const [row] = await tx`SELECT * FROM out_of_office_deliveries
      WHERE id = ${candidate.id} AND user_id = ${candidate.user_id} FOR UPDATE`;
    if (!row || !['pending', 'sending'].includes(row.status)) return null;
    const [clock] = await tx`SELECT clock_timestamp() AS now`;
    const now = new Date(clock.now);
    if (
      new Date(row.next_attempt_at).getTime() > now.getTime() ||
      (row.status === 'sending' && new Date(row.claimed_at).getTime() > now.getTime() - LEASE_MS)
    )
      return null;
    if (
      row.first_attempt_at &&
      (new Date(row.retry_until).getTime() <= now.getTime() || row.attempts >= MAX_ATTEMPTS)
    ) {
      await finish(tx, row, 'uncertain', 'confirmation_window_ended');
      return null;
    }
    const reason = await currentSuppression(tx, row, owner, from, now);
    if (reason) {
      await finish(tx, row, row.first_attempt_at ? 'uncertain' : 'suppressed', reason);
      return null;
    }
    const [sender] = await tx`SELECT s.*, d.status AS delivery_status
      FROM out_of_office_senders s JOIN out_of_office_deliveries d ON d.id = s.delivery_id
      WHERE s.user_id = ${row.user_id} AND s.sender = ${row.recipient} FOR UPDATE OF s`;
    if (
      sender &&
      sender.delivery_id !== row.id &&
      (sender.blocked ||
        ['pending', 'sending', 'uncertain'].includes(sender.delivery_status) ||
        new Date(sender.next_allowed_at).getTime() > now.getTime())
    ) {
      await finish(tx, row, 'suppressed', 'sender_cooldown');
      return null;
    }
    if (!row.quota_reserved) {
      const quota = await claimOutboundEmailQuota(/** @type {any} */ (tx), row.user_id);
      if (!quota.authorized || !quota.quota_claimed) return null;
    }
    await tx`INSERT INTO out_of_office_senders (user_id, sender, delivery_id, next_allowed_at)
      VALUES (${row.user_id}, ${row.recipient}, ${row.id}, ${now.toISOString()}::timestamptz + interval '4 days')
      ON CONFLICT (user_id, sender) DO UPDATE SET delivery_id = EXCLUDED.delivery_id,
        next_allowed_at = CASE WHEN out_of_office_senders.delivery_id = EXCLUDED.delivery_id
          THEN out_of_office_senders.next_allowed_at ELSE EXCLUDED.next_allowed_at END`;
    const token = crypto.randomUUID();
    const [claimed] = await tx`UPDATE out_of_office_deliveries SET status = 'sending',
      attempts = attempts + 1, quota_reserved = true, claimed_at = ${now.toISOString()}, claim_token = ${token},
      first_attempt_at = coalesce(first_attempt_at, ${now.toISOString()}::timestamptz),
      retry_until = coalesce(retry_until, ${now.toISOString()}::timestamptz + interval '23 hours')
      WHERE id = ${row.id} AND user_id = ${row.user_id} RETURNING *`;
    return claimed;
  });
}

/**
 * Only the responder lock spans the <=10s provider call. A plain users read
 * avoids conflicting with KEY SHARE foreign-key checks for new inbound rows.
 * End now takes the responder lock first, so waiting cannot block ingest.
 * Once committed it prevents later dispatch; it cannot recall underway mail.
 * @param {import('postgres').Sql} sql @param {any} claimed @param {import('./outbound.js').SendServices} services
 * @param {number} [deadline]
 */
export async function dispatchAutoReply(sql, claimed, services, deadline = Infinity) {
  if (Date.now() >= deadline) return 'deferred';
  return sql.begin(async (tx) => {
    await lockOutOfOfficeDispatch(tx, claimed.user_id);
    const [owner] = await tx`SELECT id, email, auth0_sub, prefs -> 'outOfOffice' AS settings
      FROM users WHERE id = ${claimed.user_id}`;
    const [row] = await tx`SELECT * FROM out_of_office_deliveries
      WHERE id = ${claimed.id} AND user_id = ${claimed.user_id} FOR UPDATE`;
    if (!row || row.status !== 'sending' || row.claim_token !== claimed.claim_token)
      return 'skipped';
    const [clock] = await tx`SELECT clock_timestamp() AS now`;
    const now = new Date(clock.now);
    if (new Date(row.retry_until).getTime() <= now.getTime())
      return finish(tx, row, 'uncertain', 'confirmation_window_ended');
    const reason = await currentSuppression(tx, row, owner, configuredEmailFrom(services.env), now);
    if (reason) return finish(tx, row, 'uncertain', reason);
    const timeoutMs = Math.min(AUTO_REPLY_PROVIDER_TIMEOUT_MS, deadline - Date.now());
    // Database/lock latency consumes the same budget. An already committed
    // claim remains recoverable if this invocation has no time left to send.
    if (timeoutMs <= 0) return 'deferred';
    const send =
      services.sendAutoReply ??
      ((payload, key, timeout) =>
        sendAutoReply(payload, key, services.env.RESEND_API_KEY, fetch, timeout));
    const outcome = await send(row.payload, `out-of-office/${row.id}`, timeoutMs);
    if (outcome.status === 'sent') {
      await tx`UPDATE out_of_office_deliveries SET status = 'sent', provider_id = ${outcome.providerId},
        sent_at = clock_timestamp(), claimed_at = NULL, claim_token = NULL, reason = NULL
        WHERE id = ${row.id} AND user_id = ${row.user_id}`;
      await tx`UPDATE out_of_office_senders SET next_allowed_at = clock_timestamp() + interval '4 days'
        WHERE user_id = ${row.user_id} AND delivery_id = ${row.id}`;
      return 'sent';
    }
    if (outcome.status === 'uncertain' || (outcome.status === 'rejected' && row.attempts > 1))
      return finish(tx, row, 'uncertain', 'provider_confirmation_required');
    if (outcome.status === 'rejected') return finish(tx, row, 'failed', 'provider_rejected');
    const next = new Date(
      now.getTime() + Math.min(3600, 60 * 2 ** row.attempts) * 1000,
    ).toISOString();
    await tx`UPDATE out_of_office_deliveries SET status = 'pending', reason = 'awaiting_confirmation',
      claimed_at = NULL, claim_token = NULL, next_attempt_at = ${next}
      WHERE id = ${row.id} AND user_id = ${row.user_id}`;
    return 'retried';
  });
}

/** @param {import('postgres').Sql} sql @param {import('./outbound.js').SendServices} services @param {number} deadline */
async function repairSentCopies(sql, services, deadline) {
  if (Date.now() >= deadline) return;
  const rows = await sql`SELECT * FROM out_of_office_deliveries
    WHERE status = 'sent' AND provider_id IS NOT NULL AND sent_message_id IS NULL
    ORDER BY sent_at LIMIT 5`;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    try {
      const result = await storeSentMessage(
        sql,
        row.user_id,
        {
          recipients: row.payload.to,
          subject: row.payload.subject,
          text: row.payload.text,
          html: null,
          replyToMessageId: row.message_id,
          resendId: row.provider_id,
          readReceiptToken: null,
        },
        { ...services, env: { ...services.env, EMAIL_FROM: row.payload.from } },
      );
      await sql`UPDATE out_of_office_deliveries SET sent_message_id = ${result.messageUuid}
        WHERE id = ${row.id} AND user_id = ${row.user_id}`;
      if (result.inserted) services.indexSentMessage(result.messageUuid);
    } catch {
      console.warn('out_of_office_sent_copy_pending');
    }
  }
}

/** @param {import('postgres').Sql} sql @param {import('./outbound.js').SendServices} services */
export async function flushOutOfOffice(sql, services) {
  // All attempts share this budget, rather than multiplying the provider
  // timeout by the batch size. Platform interruption leaves durable claims.
  const deadline = Date.now() + AUTO_REPLY_FLUSH_BUDGET_MS;
  const from = configuredEmailFrom(services.env);
  await enqueueAutoReplies(sql, from, deadline);
  if (Date.now() >= deadline) return;
  const candidates = await sql`SELECT id, user_id FROM out_of_office_deliveries
    WHERE (status = 'pending' OR (status = 'sending' AND claimed_at <= clock_timestamp() - interval '2 minutes'))
      AND next_attempt_at <= clock_timestamp()
    ORDER BY next_attempt_at, created_at LIMIT ${AUTO_REPLY_SEND_LIMIT}`;
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    try {
      const claimed = await claimAutoReply(sql, candidate, from);
      if (claimed) await dispatchAutoReply(sql, claimed, services, deadline);
    } catch {
      // The committed lease preserves a possibly consumed reservation and key.
      console.warn('out_of_office_delivery_pending');
    }
  }
  await repairSentCopies(sql, services, deadline);
}

/**
 * HTTP waitUntil shares 30s across all of the request's promises. Close a
 * stalled dedicated client at 22s, leaving cleanup/indexing margin. Postgres.js
 * end(timeout: 0) rejects pending queries and destroys only this client's
 * connections. A cancelled transaction rolls back; earlier leases stay durable.
 * @param {import('postgres').Sql} sql @param {import('./outbound.js').SendServices} services
 */
export async function runOutOfOfficeInBackground(sql, services) {
  const closeTimer = setTimeout(() => {
    void sql.end({ timeout: 0 }).catch(() => undefined);
  }, AUTO_REPLY_FLUSH_BUDGET_MS + 2_000);
  try {
    await flushOutOfOffice(sql, services);
  } finally {
    clearTimeout(closeTimer);
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

/** Keep automatic work off the scheduled caller's existing 20-second deadline.
 * @param {import('postgres').Sql} sql @param {import('./outbound.js').SendServices} services
 * @param {(sql: import('postgres').Sql, services: import('./outbound.js').SendServices) => Promise<Response>} scheduled
 * @param {(promise: Promise<unknown>) => void} waitUntil
 * @param {() => Promise<unknown>} automatic Owns a separate SQL client's lifetime.
 */
export async function flushWithOutOfOffice(sql, services, scheduled, waitUntil, automatic) {
  let response;
  try {
    response = await scheduled(sql, services);
  } catch {
    response = Response.json({ error: 'Flush failed' }, { status: 500 });
  }
  try {
    waitUntil(
      automatic().catch(() => {
        console.warn('out_of_office_flush_pending');
      }),
    );
  } catch {
    console.warn('out_of_office_flush_pending');
  }
  return response;
}
