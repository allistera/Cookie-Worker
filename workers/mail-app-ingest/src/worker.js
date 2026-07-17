import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { AI_MODEL, enrichMessage } from './enrich.js';
import { parseEmail } from './parse.js';
import {
  captureHandledException, createSentryOptions, isTransientForwardError, redact,
} from './sentry.js';
import { storeEmail } from './store.js';

export { redact } from './sentry.js';

export const STORE_BUDGET_MS = 5000;
export const MAX_PARSE_BYTES = 10 * 1024 * 1024;

const worker = {
  /**
   * @param {ForwardableEmailMessage} message
   * @param {Env & {SENTRY_DSN?: string, OPENAI_API_KEY?: string, AI_MODEL?: string}} env
   * @param {ExecutionContext} ctx
   */
  async email(message, env, ctx) {
    const rawSize = message.rawSize ?? 0;
    if (rawSize > MAX_PARSE_BYTES) {
      console.log(JSON.stringify({ event: 'store_skipped_oversize', raw_size: rawSize }));
      await message.forward(env.FORWARD_TO);
      return;
    }

    /** @type {Awaited<ReturnType<typeof parseEmail>> | null} */
    let record = null;
    /** @type {Promise<Awaited<ReturnType<typeof storeEmail>>> | null} */
    let storePromise = null;
    /** @type {import('postgres').Sql | null} */
    let sql = null;
    /** @type {Awaited<ReturnType<typeof storeEmail>> | null} */
    let storeResult = null;
    /** When true, a waitUntil task owns sql.end — main path must not end it. */
    let sqlOwnedByWaitUntil = false;

    try {
      record = await parseEmail(message);
      sql = createSql(env.HYPERDRIVE.connectionString);
      storePromise = storeEmail(sql, record, env.OWNER_EMAIL);
      storeResult = await withTimeout(storePromise, STORE_BUDGET_MS);
      console.log(JSON.stringify({
        event: 'stored',
        outcome: storeResult.outcome,
        message_id: record.messageId,
        raw_size: record.rawSize,
        attachments: record.attachments.length,
        truncated: record.truncated,
      }));
    } catch (err) {
      console.log(JSON.stringify({
        event: 'store_failed',
        error: redact(err, env.HYPERDRIVE.connectionString),
        message_id: record?.messageId,
        raw_size: record?.rawSize ?? rawSize,
      }));
      captureHandledException('store', err, [env.HYPERDRIVE.connectionString], {
        message_id: record?.messageId,
        raw_size: record?.rawSize ?? rawSize,
      });
      // Only keep the store running past the budget; hard failures are already done.
      if (storePromise && record && isStoreTimeout(err) && sql) {
        sqlOwnedByWaitUntil = true;
        const lateSql = sql;
        const lateRecord = record;
        const apiKey = env.OPENAI_API_KEY;
        const connectionString = env.HYPERDRIVE.connectionString;
        ctx.waitUntil(storePromise
          .then(async (lateResult) => {
            console.log(JSON.stringify({
              event: 'stored_late',
              outcome: lateResult.outcome,
              message_id: lateRecord.messageId,
            }));
            await endSql(lateSql);
            if (lateResult.outcome === 'inserted' && lateResult.messageUuid && apiKey) {
              await runAiEnrichment(env, lateRecord, lateResult.messageUuid, true);
            }
          })
          .catch((lateErr) => {
            captureHandledException('store_late', lateErr, [connectionString], {
              message_id: lateRecord.messageId,
            });
          })
          .finally(() => endSql(lateSql)));
      }
    }

    try {
      await message.forward(env.FORWARD_TO);
    } catch (err) {
      // Transient forward errors propagate so the sending MTA retries
      // (idempotent storage makes the retry safe). Permanent errors would
      // retry forever and bounce, so once the message is safely stored we
      // accept it and only log the lost forward.
      if (!storeResult || !isPermanentForwardError(err)) {
        // Transient errors are filtered out of Sentry (see createSentryOptions),
        // so this log line is their only trail.
        if (isTransientForwardError(err)) {
          console.log(JSON.stringify({
            event: 'forward_failed_transient',
            error: redact(err, env.HYPERDRIVE.connectionString),
            message_id: record?.messageId,
          }));
        }
        if (sql && !sqlOwnedByWaitUntil) ctx.waitUntil(endSql(sql));
        throw err;
      }
      console.log(JSON.stringify({
        event: 'forward_failed_permanent',
        error: redact(err, env.HYPERDRIVE.connectionString),
        message_id: record?.messageId,
      }));
      captureHandledException('forward', err, [env.HYPERDRIVE.connectionString], {
        message_id: record?.messageId,
        permanent: true,
      });
    }

    if (
      sql
      && !sqlOwnedByWaitUntil
      && record
      && storeResult?.outcome === 'inserted'
      && storeResult.messageUuid
      && env.OPENAI_API_KEY
    ) {
      sqlOwnedByWaitUntil = true;
      const ingestSql = sql;
      const embedRecord = record;
      const messageUuid = storeResult.messageUuid;
      ctx.waitUntil(endSql(ingestSql)
        .then(() => runAiEnrichment(env, embedRecord, messageUuid, false)));
    } else if (sql && !sqlOwnedByWaitUntil) {
      ctx.waitUntil(endSql(sql));
    }
  },

  /**
   * Repairs interrupted best-effort enrichment without touching delivery.
   * @param {ScheduledController} _controller
   * @param {Env & {OPENAI_API_KEY?: string, AI_MODEL?: string}} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(recoverPendingEnrichment(env));
  },
};

/**
 * AI is strictly best-effort and receives a fresh Hyperdrive client after the
 * ingest connection is closed. Failures never affect forwarding.
 * @param {Env & {OPENAI_API_KEY?: string, AI_MODEL?: string}} env
 * @param {any} record
 * @param {string} messageUuid
 * @param {boolean} late
 */
async function runAiEnrichment(env, record, messageUuid, late) {
  if (!env.OPENAI_API_KEY) return;
  const sql = createSql(env.HYPERDRIVE.connectionString);
  try {
    await enrichMessage(sql, record, messageUuid, env.OPENAI_API_KEY, env.AI_MODEL || AI_MODEL);
  } catch (err) {
    console.log(JSON.stringify({
      event: 'ai_enrichment_failed',
      error: redact(err, env.HYPERDRIVE.connectionString, env.OPENAI_API_KEY),
      message_id: record.messageId,
    }));
    captureHandledException('ai_enrichment', err, [
      env.HYPERDRIVE.connectionString,
      env.OPENAI_API_KEY,
    ], { message_id: record.messageId, late });
  } finally {
    await endSql(sql);
  }
}

/**
 * @param {Env & {OPENAI_API_KEY?: string, AI_MODEL?: string}} env
 */
export async function recoverPendingEnrichment(env) {
  if (!env.OPENAI_API_KEY) return;
  const sql = createSql(env.HYPERDRIVE.connectionString);
  let rows;
  try {
    rows = await sql`
      SELECT m.id, m.message_id, m.from_address, m.subject, m.body_text
      FROM message_ai ai
      JOIN messages m ON m.id = ai.message_id
      JOIN users u ON u.id = m.user_id
      WHERE u.email = ${env.OWNER_EMAIL}
        AND ai.status IN ('pending', 'failed')
        AND ai.updated_at < now() - interval '2 minutes'
      ORDER BY ai.updated_at
      LIMIT 3
    `;
  } finally {
    await endSql(sql);
  }
  await Promise.all(rows.map((row) => runAiEnrichment(env, {
    messageId: row.message_id || `<${row.id}@recovery.cookie>`,
    fromAddress: row.from_address,
    subject: row.subject,
    bodyText: row.body_text,
  }, row.id, false)));
  console.log(JSON.stringify({ event: 'ai_recovery_complete', attempted: rows.length }));
}

export default Sentry.withSentry(createSentryOptions, worker);

const PERMANENT_FORWARD_ERRORS = [
  /non-authenticated emails cannot be forwarded/iu,
  /destination address (?:is )?not verified/iu,
];

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

/**
 * @param {string} databaseUrl
 */
export function createSql(databaseUrl) {
  try {
    // No ssl option: the Hyperdrive endpoint does not speak TLS itself —
    // Hyperdrive terminates TLS to the origin database. Asking the driver
    // for TLS here makes every connect fail and retry until the invocation
    // dies with "Too many subrequests".
    return postgres(databaseUrl, {
      prepare: false,
      max: 1,
      idle_timeout: 10,
      connect_timeout: 10,
    });
  } catch {
    throw new Error('database connection string is not valid');
  }
}

/**
 * Best-effort client teardown so isolate reuse does not leave sockets open.
 * @param {import('postgres').Sql | null | undefined} sql
 */
export function endSql(sql) {
  if (!sql) return Promise.resolve();
  return sql.end({ timeout: 2 }).catch(() => undefined);
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`store timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
