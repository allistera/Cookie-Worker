import postgres from 'postgres';
import { embedMessage } from './embed.js';
import { parseEmail } from './parse.js';
import { storeEmail } from './store.js';

export const STORE_BUDGET_MS = 5000;
export const MAX_PARSE_BYTES = 10 * 1024 * 1024;

export default {
  /**
   * @param {ForwardableEmailMessage} message
   * @param {{DATABASE_URL: string, FORWARD_TO: string, OWNER_EMAIL: string, OPENAI_API_KEY?: string}} env
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

    try {
      record = await parseEmail(message);
      sql = createSql(env.DATABASE_URL);
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
        error: redact(err, env.DATABASE_URL),
        message_id: record?.messageId,
        raw_size: record?.rawSize ?? rawSize,
      }));
      if (storePromise && record) {
        ctx.waitUntil(storePromise
          .then((lateResult) => {
            console.log(JSON.stringify({
              event: 'stored_late',
              outcome: lateResult.outcome,
              message_id: record?.messageId,
            }));
          })
          .catch(() => undefined));
      }
    }

    try {
      await message.forward(env.FORWARD_TO);
    } catch (err) {
      // Transient forward errors propagate so the sending MTA retries
      // (idempotent storage makes the retry safe). Permanent errors would
      // retry forever and bounce, so once the message is safely stored we
      // accept it and only log the lost forward.
      if (!storeResult || !isPermanentForwardError(err)) throw err;
      console.log(JSON.stringify({
        event: 'forward_failed_permanent',
        error: redact(err, env.DATABASE_URL),
        message_id: record?.messageId,
      }));
    }

    if (
      sql
      && record
      && storeResult?.outcome === 'inserted'
      && storeResult.messageUuid
      && env.OPENAI_API_KEY
    ) {
      ctx.waitUntil(embedMessage(sql, record, storeResult.messageUuid, env.OPENAI_API_KEY)
        .catch((err) => {
          console.log(JSON.stringify({
            event: 'embed_failed',
            error: redact(err, env.DATABASE_URL, env.OPENAI_API_KEY),
            message_id: record?.messageId,
          }));
        }));
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
 * @param {string} databaseUrl
 */
export function createSql(databaseUrl) {
  try {
    return postgres(databaseUrl, {
      prepare: false,
      ssl: 'require',
      max: 1,
      idle_timeout: 10,
      connect_timeout: 10,
    });
  } catch {
    throw new Error('DATABASE_URL is not a valid connection string');
  }
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
