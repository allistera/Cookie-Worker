import postgres from 'postgres';
import { embedMessage } from './embed.js';
import { parseEmail } from './parse.js';
import { storeEmail } from './store.js';

export const STORE_BUDGET_MS = 5000;
export const MAX_PARSE_BYTES = 10 * 1024 * 1024;

export default {
  /**
   * @param {ForwardableEmailMessage} message
   * @param {{HYPERDRIVE: {connectionString: string}, FORWARD_TO: string, OWNER_EMAIL: string, OPENAI_API_KEY?: string}} env
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
            if (
              lateResult.outcome === 'inserted'
              && lateResult.messageUuid
              && apiKey
            ) {
              await embedMessage(lateSql, lateRecord, lateResult.messageUuid, apiKey)
                .catch((embedErr) => {
                  console.log(JSON.stringify({
                    event: 'embed_failed',
                    error: redact(embedErr, connectionString, apiKey),
                    message_id: lateRecord.messageId,
                  }));
                });
            }
          })
          .catch(() => undefined)
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
        if (sql && !sqlOwnedByWaitUntil) ctx.waitUntil(endSql(sql));
        throw err;
      }
      console.log(JSON.stringify({
        event: 'forward_failed_permanent',
        error: redact(err, env.HYPERDRIVE.connectionString),
        message_id: record?.messageId,
      }));
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
      const embedSql = sql;
      const embedRecord = record;
      const apiKey = env.OPENAI_API_KEY;
      const connectionString = env.HYPERDRIVE.connectionString;
      ctx.waitUntil(embedMessage(embedSql, embedRecord, storeResult.messageUuid, apiKey)
        .catch((err) => {
          console.log(JSON.stringify({
            event: 'embed_failed',
            error: redact(err, connectionString, apiKey),
            message_id: embedRecord.messageId,
          }));
        })
        .finally(() => endSql(embedSql)));
    } else if (sql && !sqlOwnedByWaitUntil) {
      ctx.waitUntil(endSql(sql));
    }
  },
};

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

/**
 * @param {unknown} err
 * @param {...(string | undefined)} secrets
 */
export function redact(err, ...secrets) {
  let text = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text;
}
