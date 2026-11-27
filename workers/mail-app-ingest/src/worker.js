import { withApplicationMetrics } from '../../../shared/applicationMetrics.js';
import { withSqlMetrics } from '../../../shared/sqlMetrics.js';
import * as Sentry from '@sentry/cloudflare';
import { deleteUploadedAttachments, uploadAttachments } from './attachments.js';
import {
  AI_MODEL,
  enrichMessage,
  isBlockedRegionError,
  MAX_ENRICHMENT_ATTEMPTS,
} from './enrich.js';
import { syncMessageToMeili } from '../../../shared/meiliSync.js';
import { MimePartLimitError, parseEmail } from './parse.js';
import {
  sweepSearchDrift,
  sweepWorkspaceSearchDrift,
  WORKSPACE_SWEEP_CRON,
} from './searchDriftSweep.js';
import { purgeExpiredSpam } from './spamRetentionSweep.js';
import { purgeExpiredNotificationEvents } from './notificationEventsSweep.js';
import { runInboundHealthChecks } from './inboundHealth.js';
import { runDbHealthChecks } from './dbHealth.js';
import { createSql, endSql } from '../../../shared/db.js';
import { retryWithBackoff } from '../../../shared/retry.js';
import { setSpanAttributes } from '../../../shared/tracing.js';
import { isTransientDbError } from '../../../shared/transient-db.js';
import {
  captureHandledException,
  createSentryOptions,
  isTransientForwardError,
  redact,
} from './sentry.js';
import { emailAlreadyStored, storeEmail } from './store.js';

import { configureOpenAi } from '../../../shared/openai.js';

const STORE_BUDGET_MS = 5000;
export const MAX_PARSE_BYTES = 10 * 1024 * 1024;
// Rows one recovery tick enriches, concurrently. Each still claims a slot of
// the shared inbound AI budget (exhaustion defers without spending an
// attempt), so this only bounds how fast a backlog drains, not what it costs.
export const RECOVERY_BATCH_SIZE = 10;
// One stable Sentry cron monitor per schedule. Sentry creates each monitor from
// its schedule on the first check-in, then reports a missed or failed run.
const SWEEPS_MONITOR = { slug: 'mail-app-ingest-sweeps', schedule: '*/15 * * * *' };
const WORKSPACE_SWEEP_MONITOR = {
  slug: 'mail-app-ingest-workspace-search-drift',
  schedule: WORKSPACE_SWEEP_CRON,
};

/**
 * @param {string} schedule
 * @returns {NonNullable<Parameters<typeof Sentry.withMonitor>[2]>}
 */
function monitorConfig(schedule) {
  return {
    schedule: { type: 'crontab', value: schedule },
    checkinMargin: 5,
    maxRuntime: 10,
    timezone: 'UTC',
  };
}

const worker = {
  /**
   * @param {ForwardableEmailMessage} message
   * @param {Env & {SENTRY_DSN?: string, OPENAI_API_KEY?: string, BLOB_READ_WRITE_TOKEN?: string, AI_MODEL?: string, MEILISEARCH_URL?: string, MEILISEARCH_API_KEY?: string}} env
   * @param {ExecutionContext} ctx
   */
  async email(message, env, ctx) {
    configureOpenAi(env);
    const rawSize = message.rawSize ?? 0;
    if (rawSize > MAX_PARSE_BYTES) {
      console.log(JSON.stringify({ event: 'store_skipped_oversize', raw_size: rawSize }));
      setSpanAttributes({ 'cookie.ingest.outcome': 'skipped_oversize' });
      await forwardOriginal(message, env);
      return;
    }

    /** @type {Awaited<ReturnType<typeof parseEmail>>} */
    let record;
    /** @type {Promise<Awaited<ReturnType<typeof storeEmail>>> | null} */
    let storePromise = null;
    /** @type {import('postgres').Sql | null} */
    let sql = null;
    /** @type {Awaited<ReturnType<typeof storeEmail>> | null} */
    let storeResult = null;
    /** @type {Awaited<ReturnType<typeof uploadAttachments>> | null} */
    let uploaded = null;
    /** When true, a waitUntil task owns sql.end — main path must not end it. */
    let sqlOwnedByWaitUntil = false;

    try {
      record = await parseEmail(message);
    } catch (err) {
      // A boundary-line bomb is a permanent property of the message: storing
      // it would build an enormous MIME tree, and rethrowing would make the
      // MTA redeliver it forever. Treat it like the oversize case — skip
      // storage, forward once, accept.
      if (err instanceof MimePartLimitError) {
        console.log(
          JSON.stringify({
            event: 'store_skipped_mime_parts',
            boundary_lines: err.boundaryLines,
            raw_size: rawSize,
          }),
        );
        setSpanAttributes({ 'cookie.ingest.outcome': 'skipped_mime_parts' });
        await forwardOriginal(message, env);
        return;
      }
      // Any other parse failure is just as permanent: the same bytes break the
      // parser on every redelivery, so a retry only delays the bounce and the
      // mailbox never gets its copy. Report it, forward once, accept.
      console.log(
        JSON.stringify({
          event: 'store_skipped_parse_failed',
          error: err instanceof Error ? err.message : String(err),
          raw_size: rawSize,
        }),
      );
      setSpanAttributes({ 'cookie.ingest.outcome': 'skipped_parse_failed' });
      captureHandledException('parse', err, [], { raw_size: rawSize });
      await forwardOriginal(message, env);
      return;
    }

    try {
      sql = createSql(env.HYPERDRIVE.connectionString);
      // One read resolves the owner and checks for a duplicate; the store
      // below reuses the owner id rather than looking it up again.
      let owner;
      try {
        owner = await emailAlreadyStored(sql, record.messageId, env.OWNER_EMAIL);
      } catch (err) {
        // This first query opens the connection, and Hyperdrive sometimes
        // fails to reach the origin on that first try (Sentry COOKIE-WEB-9).
        // One more client delivers the message now instead of leaving it to
        // the sender's retry minutes later.
        if (!isTransientDbError(err)) throw err;
        console.log(JSON.stringify({ event: 'store_connection_retried' }));
        ctx.waitUntil(endSql(sql));
        sql = createSql(env.HYPERDRIVE.connectionString);
        owner = await emailAlreadyStored(sql, record.messageId, env.OWNER_EMAIL);
      }
      if (owner.alreadyStored) {
        storeResult = { outcome: 'duplicate', messageUuid: null };
      } else {
        uploaded = await uploadAttachments(
          record.attachments,
          record.messageId,
          env.BLOB_READ_WRITE_TOKEN,
        );
        record.attachments = uploaded.attachments;
        for (const failure of uploaded.failures) {
          console.log(
            JSON.stringify({
              event: 'attachment_upload_failed',
              index: failure.index,
              message_id: record.messageId,
              error: redact(failure.error, env.BLOB_READ_WRITE_TOKEN),
            }),
          );
          captureHandledException('attachment_upload', failure.error, [env.BLOB_READ_WRITE_TOKEN], {
            message_id: record.messageId,
            attachment_index: failure.index,
          });
        }
        storePromise = storeEmail(sql, record, owner.userId);
        storeResult = await withTimeout(storePromise, STORE_BUDGET_MS);
        if (storeResult.outcome === 'duplicate') {
          await discardUploadedAttachments(uploaded.attachments, env, record.messageId);
        }
      }
      console.log(
        JSON.stringify({
          event: 'stored',
          outcome: storeResult.outcome,
          message_id: record.messageId,
          raw_size: record.rawSize,
          attachments: record.attachments.length,
          attachments_skipped: uploaded?.skipped ?? 0,
          truncated: record.truncated,
        }),
      );
      // The trace's view of the same outcome: counts and flags, no identifiers.
      setSpanAttributes({
        'cookie.ingest.outcome': storeResult.outcome,
        'cookie.ingest.attachments': record.attachments.length,
        'cookie.ingest.attachments_skipped': uploaded?.skipped ?? 0,
        'cookie.ingest.truncated': record.truncated,
      });
    } catch (err) {
      console.log(
        JSON.stringify({
          event: 'store_failed',
          error: redact(err, env.HYPERDRIVE.connectionString),
          message_id: record?.messageId,
          raw_size: record?.rawSize ?? rawSize,
        }),
      );
      // A store that only ran past the budget keeps going in waitUntil below
      // and usually commits seconds later (Sentry COOKIE-WEB-Q: every event
      // was stored exactly once). Its outcome is what matters, so a timeout
      // reports only if that late store fails (store_late); the MTA retry
      // covers a store that never settles.
      const lateStore = Boolean(storePromise && record && isStoreTimeout(err) && sql);
      setSpanAttributes({ 'cookie.ingest.outcome': lateStore ? 'store_late' : 'store_failed' });
      if (!lateStore) {
        captureHandledException('store', err, [env.HYPERDRIVE.connectionString], {
          message_id: record?.messageId,
          raw_size: record?.rawSize ?? rawSize,
        });
      }
      // Only keep the store running past the budget; hard failures are already done.
      if (lateStore && storePromise && record && sql) {
        sqlOwnedByWaitUntil = true;
        const lateSql = sql;
        const lateRecord = record;
        const apiKey = env.OPENAI_API_KEY;
        const lateAttachments = uploaded?.attachments ?? [];
        const blobToken = env.BLOB_READ_WRITE_TOKEN;
        const connectionString = env.HYPERDRIVE.connectionString;
        ctx.waitUntil(
          storePromise
            .then(async (lateResult) => {
              console.log(
                JSON.stringify({
                  event: 'stored_late',
                  outcome: lateResult.outcome,
                  message_id: lateRecord.messageId,
                }),
              );
              if (lateResult.outcome === 'duplicate') {
                await discardUploadedAttachments(lateAttachments, env, lateRecord.messageId);
              }
              if (lateResult.outcome === 'inserted' && lateResult.messageUuid) {
                // No task wait, as on the on-time path below.
                await syncMessageToMeili(lateSql, env, lateResult.messageUuid, {
                  waitForTask: false,
                });
                if (apiKey) {
                  await runAiEnrichment(env, lateRecord, lateResult.messageUuid, 'email_late');
                }
              }
            })
            .catch(async (lateErr) => {
              captureHandledException('store_late', lateErr, [connectionString], {
                message_id: lateRecord.messageId,
              });
              await discardUploadedAttachments(
                lateAttachments,
                { ...env, BLOB_READ_WRITE_TOKEN: blobToken },
                lateRecord.messageId,
              );
            })
            .finally(() => endSql(lateSql)),
        );
      } else if (uploaded?.attachments.length) {
        await discardUploadedAttachments(uploaded.attachments, env, record?.messageId);
      }
      // Storage did not commit. Accepting (and forwarding) would drop the
      // message from Cookie with no MTA retry. Idempotent store makes a
      // retry safe, including when a timed-out write later commits via
      // waitUntil.
      if (!storeResult) {
        if (sql && !sqlOwnedByWaitUntil) ctx.waitUntil(endSql(sql));
        throw err;
      }
    }

    if (
      sql &&
      !sqlOwnedByWaitUntil &&
      record &&
      storeResult?.outcome === 'inserted' &&
      storeResult.messageUuid
    ) {
      // Scheduled before forwarding: a transient forward error rethrows so
      // the MTA retries, and that retry finds the message already stored (a
      // duplicate) and would schedule neither step again.
      //
      // No OPENAI_API_KEY condition here: search indexing is not AI work, and
      // gating it on the classification credential meant a rotated or missing
      // key silently stopped all new mail from being searchable. That was
      // survivable when Meilisearch was one leg of a three-leg search; it is
      // the whole product now. runAiEnrichment guards the key itself.
      //
      // Classification stays after the sync rather than beside it, so an
      // unclassified document can never land in the index after the
      // classified one. The sync only waits for Meilisearch to accept the
      // document, not to finish indexing it: tasks run in enqueue order, so
      // the classified push still lands last, and polling here could eat up
      // to 20s of the waitUntil budget before classification even started.
      // It leaves the row unstamped; the classified sync (or the drift sweep)
      // stamps it. If the budget still runs out, the message_ai row stays
      // pending for the recovery cron.
      sqlOwnedByWaitUntil = true;
      const ingestSql = sql;
      const enrichRecord = record;
      const messageUuid = storeResult.messageUuid;
      ctx.waitUntil(
        syncMessageToMeili(ingestSql, env, messageUuid, { waitForTask: false })
          .then(() => endSql(ingestSql))
          .then(() => runAiEnrichment(env, enrichRecord, messageUuid, 'email')),
      );
    }

    try {
      setSpanAttributes({
        'cookie.forward.outcome': await forwardOriginal(message, env, record?.messageId),
      });
    } catch (err) {
      // Transient forward errors propagate so the sending MTA retries
      // (idempotent storage makes the retry safe). Permanent errors would
      // retry forever and bounce, so once the message is safely stored we
      // accept it and only log the lost forward.
      setSpanAttributes({
        'cookie.forward.outcome': isTransientForwardError(err)
          ? 'failed_transient'
          : 'failed_permanent',
      });
      if (!storeResult || !isPermanentForwardError(err)) {
        // Transient errors are filtered out of Sentry (see createSentryOptions),
        // so this log line is their only trail.
        if (isTransientForwardError(err)) {
          console.log(
            JSON.stringify({
              event: 'forward_failed_transient',
              error: redact(err, env.HYPERDRIVE.connectionString),
              message_id: record?.messageId,
            }),
          );
        }
        if (sql && !sqlOwnedByWaitUntil) ctx.waitUntil(endSql(sql));
        throw err;
      }
      console.log(
        JSON.stringify({
          event: 'forward_failed_permanent',
          error: redact(err, env.HYPERDRIVE.connectionString),
          message_id: record?.messageId,
        }),
      );
      // A sender that failed authentication, or whose mail Gmail refused as
      // spam, is not something Cookie can fix, and the message is already
      // stored and classified above.
      if (!isSenderCausedForwardError(err)) {
        captureHandledException('forward', err, [env.HYPERDRIVE.connectionString], {
          message_id: record?.messageId,
          permanent: true,
        });
      }
    }

    if (sql && !sqlOwnedByWaitUntil) ctx.waitUntil(endSql(sql));
  },

  /**
   * Repairs interrupted best-effort enrichment without touching delivery.
   * @param {ScheduledController} controller
   * @param {Env & {OPENAI_API_KEY?: string, AI_MODEL?: string}} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(controller, env, ctx) {
    if (controller.cron === WORKSPACE_SWEEP_CRON) {
      await Sentry.withMonitor(
        WORKSPACE_SWEEP_MONITOR.slug,
        () => {
          const repair = sweepWorkspaceSearchDrift(env, { createSql });
          ctx.waitUntil(repair);
          return repair;
        },
        monitorConfig(WORKSPACE_SWEEP_MONITOR.schedule),
      );
      return;
    }
    configureOpenAi(env);
    await Sentry.withMonitor(
      SWEEPS_MONITOR.slug,
      async () => {
        // The sweeps run side by side so one failure cannot stop another, and the
        // handler awaits them all so the cron invocation lives until they finish
        // rather than ending at return with the work cut short.
        const sweeps = Promise.allSettled([
          recoverPendingEnrichment(env),
          sweepSearchDrift(env, { createSql }),
          purgeExpiredSpam(env, { createSql }),
          purgeExpiredNotificationEvents(env, { createSql }),
        ]);
        ctx.waitUntil(sweeps);
        for (const result of await sweeps) {
          // Each sweep reports its own failures; this only catches one that escaped.
          if (result.status === 'rejected') {
            captureHandledException('scheduled', result.reason, [env.HYPERDRIVE.connectionString]);
          }
        }
        // Only after the ingest sweeps, and neither throws: a failing health
        // check cannot change the outcome of the sweeps or the cron.
        await runInboundHealthChecks(env, { createSql });
        await runDbHealthChecks(env, { createSql });
      },
      monitorConfig(SWEEPS_MONITOR.schedule),
    );
  },
};

/**
 * AI is strictly best-effort and receives a fresh Hyperdrive client after the
 * ingest connection is closed. Failures never affect forwarding.
 *
 * `trigger` says which invocation is running the enrichment. OpenAI refuses
 * a call made while handling mail from a server in a region it does not
 * serve, whatever the Worker does about it; the failed row is left for the
 * recovery cron, so on an email that refusal is a deferral to log, not an
 * error to report. The cron has no sender, so the same refusal there is
 * unexpected and is reported like any other failure.
 * @param {Env & {OPENAI_API_KEY?: string, AI_MODEL?: string, MEILISEARCH_URL?: string, MEILISEARCH_API_KEY?: string}} env
 * @param {any} record
 * @param {string} messageUuid
 * @param {'email' | 'email_late' | 'recovery'} trigger
 */
async function runAiEnrichment(env, record, messageUuid, trigger) {
  if (!env.OPENAI_API_KEY) return;
  const sql = createSql(env.HYPERDRIVE.connectionString);
  try {
    const { changed } = await enrichMessage(
      sql,
      record,
      messageUuid,
      env.OPENAI_API_KEY,
      env.AI_MODEL || AI_MODEL,
    );
    // Nothing indexed moved (already classified, user verdict, budget
    // deferral), so the document the ingest sync pushed is still current.
    if (changed) await syncMessageToMeili(sql, env, messageUuid);
  } catch (err) {
    if (trigger !== 'recovery' && isBlockedRegionError(err)) {
      console.log(
        JSON.stringify({
          event: 'ai_enrichment_deferred',
          reason: 'blocked_region',
          message_id: record.messageId,
        }),
      );
      return;
    }
    console.log(
      JSON.stringify({
        event: 'ai_enrichment_failed',
        error: redact(err, env.HYPERDRIVE.connectionString, env.OPENAI_API_KEY),
        message_id: record.messageId,
      }),
    );
    captureHandledException(
      'ai_enrichment',
      err,
      [env.HYPERDRIVE.connectionString, env.OPENAI_API_KEY],
      { message_id: record.messageId, late: trigger === 'email_late' },
    );
  } finally {
    await endSql(sql);
  }
}

/**
 * @param {{blob_url?: string | null}[]} attachments
 * @param {Env & {BLOB_READ_WRITE_TOKEN?: string}} env
 * @param {string | undefined} messageId
 */
async function discardUploadedAttachments(attachments, env, messageId) {
  try {
    const deleted = await deleteUploadedAttachments(attachments, env.BLOB_READ_WRITE_TOKEN);
    if (deleted > 0) {
      console.log(
        JSON.stringify({
          event: 'attachment_blobs_deleted',
          count: deleted,
          message_id: messageId,
        }),
      );
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'attachment_blob_cleanup_failed',
        message_id: messageId,
        error: redact(error, env.BLOB_READ_WRITE_TOKEN),
      }),
    );
    captureHandledException('attachment_cleanup', error, [env.BLOB_READ_WRITE_TOKEN], {
      message_id: messageId,
    });
  }
}

/**
 * @param {Env & {OPENAI_API_KEY?: string, AI_MODEL?: string}} env
 */
export async function recoverPendingEnrichment(env) {
  if (!env.OPENAI_API_KEY) return;
  let rows;
  try {
    rows = await retryWithBackoff(
      async () => {
        const sql = createSql(env.HYPERDRIVE.connectionString);
        try {
          return await sql.begin(async (tx) => {
            // 'completed' rows are never candidates: enrichMessage no-ops the
            // moment classification has completed (Meilisearch generates a
            // message's embedding itself once the message is indexed, so
            // there is no longer a post-classification step this sweep needs
            // to recover). A 'completed' branch here without real pending
            // work would just re-select and re-stamp the same rows forever
            // on this 15-minute cron.
            const candidates = await tx`
              SELECT m.id, m.message_id, m.from_address, m.subject, m.body_text
              FROM message_ai ai
              JOIN messages m ON m.id = ai.message_id
              JOIN users u ON u.id = m.user_id
              WHERE u.email = ${env.OWNER_EMAIL}
                AND ai.status IN ('pending', 'failed')
                -- A row that has failed MAX_ENRICHMENT_ATTEMPTS times stays
                -- failed rather than spending the shared AI budget forever.
                AND ai.enrichment_attempts < ${MAX_ENRICHMENT_ATTEMPTS}
                AND ai.updated_at < now() - interval '2 minutes'
              ORDER BY ai.updated_at
              LIMIT ${RECOVERY_BATCH_SIZE}
              FOR UPDATE OF ai SKIP LOCKED
            `;
            if (candidates.length > 0) {
              // Re-stamp updated_at while holding the row locks: this doubles as a
              // lease, so a concurrent cron's staleness filter (updated_at < now()
              // - 2 minutes) skips these rows instead of enriching them twice.
              // Writes downstream stay idempotent either way — the lease only
              // avoids duplicated OpenAI spend.
              await tx`
                UPDATE message_ai
                SET updated_at = now()
                WHERE message_id IN ${tx(candidates.map((row) => row.id))}
              `;
            }
            return candidates;
          });
        } finally {
          await endSql(sql);
        }
      },
      { attempts: 3, isRetryable: isTransientDbError },
    );
  } catch (err) {
    captureHandledException('ai_recovery', err, [env.HYPERDRIVE.connectionString]);
    return;
  }
  if (!Array.isArray(rows)) return;
  await Promise.all(
    rows.map((row) =>
      runAiEnrichment(
        env,
        {
          messageId: row.message_id || `<${row.id}@recovery.cookie>`,
          fromAddress: row.from_address,
          subject: row.subject,
          bodyText: row.body_text,
        },
        row.id,
        'recovery',
      ),
    ),
  );
  console.log(JSON.stringify({ event: 'ai_recovery_complete', attempted: rows.length }));
}

export default Sentry.withSentry(
  createSentryOptions,
  withApplicationMetrics(withSqlMetrics(worker, 'mail-app-ingest'), 'mail-app-ingest'),
);

/**
 * Gmail's auto-forwarding rewrites the envelope sender to
 * `<account>+caf_=<recipient local>=<recipient domain>@<account domain>`, so
 * a delivery carrying that sender for `mailbox` came out of that mailbox.
 *
 * The envelope sender is unauthenticated, and that is acceptable here: a
 * forged one only costs the mailbox its copy, never Cookie's stored one.
 *
 * @param {unknown} envelopeFrom
 * @param {unknown} mailbox
 */
export function isAutoForwardedFrom(envelopeFrom, mailbox) {
  const [local, domain] = String(mailbox ?? '')
    .toLowerCase()
    .split('@');
  if (!local || !domain) return false;
  const sender = String(envelopeFrom ?? '').toLowerCase();
  return sender.startsWith(`${local}+caf_=`) && sender.endsWith(`@${domain}`);
}

/**
 * Sends the original on to `FORWARD_TO`, except when that mailbox is where the
 * message was auto-forwarded from. It keeps its own copy, so sending the
 * message back adds nothing, and Gmail rate limits those copies (`421 4.7.28`)
 * like any other mail, which made the handler throw and Gmail redeliver a
 * message Cookie had already stored, for hours at a time.
 *
 * @param {ForwardableEmailMessage} message
 * @param {{FORWARD_TO: string}} env
 * @param {string} [messageId]
 * @returns {Promise<'forwarded' | 'skipped_auto_forwarded'>}
 */
async function forwardOriginal(message, env, messageId) {
  if (isAutoForwardedFrom(message.from, env.FORWARD_TO)) {
    console.log(JSON.stringify({ event: 'forward_skipped_auto_forwarded', message_id: messageId }));
    return 'skipped_auto_forwarded';
  }
  await message.forward(env.FORWARD_TO);
  return 'forwarded';
}

// Cloudflare refuses to forward mail whose sender failed SPF, DKIM, or DMARC.
const UNAUTHENTICATED_SENDER_ERROR = /non-authenticated emails cannot be forwarded/iu;

// Gmail refuses the forwarded copy of mail it judges to be spam with
// "550 5.7.1 ... this message is likely unsolicited mail". Its other 5.7.1
// refusals (a low-reputation sending domain or address) do not match: those
// point at Cookie's own forwarding path and stay reported.
const UNSOLICITED_MAIL_ERROR = /likely unsolicited mail/iu;

const PERMANENT_FORWARD_ERRORS = [
  // Cloudflare includes the upstream SMTP result in this fixed wrapper.
  // A permanent 5xx refusal cannot be repaired by redelivering the same mail.
  /^could not send email:.*permanent error \(5\d\d\):/isu,
  UNAUTHENTICATED_SENDER_ERROR,
  /destination address (?:is )?not verified/iu,
];

/**
 * A permanent forward failure that is the sender's doing rather than a fault
 * in Cookie's configuration: logged, never reported (Sentry COOKIE-WEB-9 for
 * unauthenticated senders, COOKIE-WEB-1T for mail Gmail refused as spam).
 *
 * @param {unknown} err
 */
function isSenderCausedForwardError(err) {
  const text = err instanceof Error ? err.message : String(err);
  return UNAUTHENTICATED_SENDER_ERROR.test(text) || UNSOLICITED_MAIL_ERROR.test(text);
}

/**
 * @param {unknown} err
 */
export function isPermanentForwardError(err) {
  const text = err instanceof Error ? err.message : String(err);
  return PERMANENT_FORWARD_ERRORS.some((pattern) => pattern.test(text));
}

/**
 * @param {unknown} err
 */
export function isStoreTimeout(err) {
  return err instanceof Error && err.message.startsWith('store timed out');
}

// Shared with cookie-web-messages, which retries reads on the same errors.
export { isTransientDbError };

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`store timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}
