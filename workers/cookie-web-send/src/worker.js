import * as Sentry from '@sentry/cloudflare';
import { del, get } from '@vercel/blob';
import postgres from 'postgres';
import { Resend } from 'resend';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { timingSafeEqualStrings } from '../../../shared/auth.js';
import { syncMessageToMeili, syncMessagesToMeili } from '../../../shared/meiliSync.js';
import {
  deliverMail,
  parseFollowUpAt,
  immediateSendIdempotencyKey,
  claimOutboundEmailQuota,
  ownedReplyToMessageId,
  parseAttachmentIds,
  refundOutboundEmailQuota,
  resolveOwnedAttachments,
  validateOutboundMessage,
} from './outbound.js';
import {
  cancelScheduledSend,
  createScheduledSend,
  handleFlush,
  listScheduledSends,
  parseScheduledFor,
} from './scheduled.js';
import { handleFollowUp } from './followUp.js';
import { captureHandledException, createSentryOptions } from './sentry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Outbound messages can include HTML bodies; keep Vercel's 4.5 MB cap for
// send, but use the shared helper for consistent JSON error handling.
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

/** @param {string} databaseUrl */
export function createSql(databaseUrl) {
  // No ssl option: Hyperdrive terminates TLS to the origin database itself;
  // asking the driver for TLS makes every connect fail (see data-enricher).
  return postgres(databaseUrl, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

/**
 * Runs a best-effort search sync after the response has been handed back.
 *
 * fetch closes the request-scoped client in its `finally` as soon as the route
 * returns, so anything that outlives the response has to own the connection it
 * runs on — hence a fresh client here, ended in a `finally` of its own. The
 * meiliSync helpers swallow their own failures; the outer catch only covers a
 * connection that could not be opened at all, which must still stay silent as
 * far as the send is concerned.
 *
 * @param {import('./sentry.js').SendEnv} env
 * @param {ExecutionContext} ctx
 * @param {(sql: import('postgres').Sql) => Promise<unknown>} sync
 */
function indexAfterResponse(env, ctx, sync) {
  ctx.waitUntil(
    (async () => {
      const sql = createSql(env.HYPERDRIVE.connectionString);
      try {
        await sync(sql);
      } finally {
        await sql.end({ timeout: 2 }).catch(() => undefined);
      }
    })().catch((err) => {
      console.error('failed to index sent mail for search:', /** @type {Error} */ (err).message);
    }),
  );
}

/**
 * Builds the per-request delivery seams.
 *
 * @param {import('./sentry.js').SendEnv} env
 * @param {ExecutionContext} ctx
 * @returns {import('./outbound.js').SendServices}
 */
export function createSendServices(env, ctx) {
  return {
    env,
    createResend: (apiKey) => new Resend(apiKey),
    readBlob: (blobUrl) => get(blobUrl, { access: 'private', token: env.BLOB_READ_WRITE_TOKEN }),
    // Used only by the flush job's orphaned-upload sweep.
    deleteBlob: (blobUrl) => del(blobUrl, { token: env.BLOB_READ_WRITE_TOKEN }),
    indexSentMessage: (messageUuid) =>
      indexAfterResponse(env, ctx, (sql) => syncMessageToMeili(sql, env, messageUuid)),
    // One flush stores up to FLUSH_BATCH_SIZE sent copies; index them in a
    // single round trip rather than one sync per delivered row.
    indexSentMessages: (messageUuids) => {
      if (!messageUuids.length) return;
      indexAfterResponse(env, ctx, (sql) => syncMessagesToMeili(sql, env, messageUuids));
    },
  };
}

/** @param {import('./sentry.js').SendEnv} env */
function sendingConfigured(env) {
  return Boolean(env.RESEND_API_KEY) && Boolean(String(env.EMAIL_FROM || '').trim());
}

/**
 * POST /send — send an email through Resend as the app's mailbox address and
 * store the sent copy, or (given a future `sendAt`) queue it as a
 * scheduled_sends row for the flush job to deliver later. Immediate sending
 * always wins: a storage failure is logged and the response is still a
 * success.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {Request} request
 * @param {import('./outbound.js').SendServices} services
 */
async function handleSend(sql, userId, request, services) {
  if (!sendingConfigured(services.env)) {
    return Response.json({ error: 'Email sending is not configured' }, { status: 503 });
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
  } catch (error) {
    const errorResponse = bodyErrorResponse(error);
    if (errorResponse) return errorResponse;
    throw error;
  }

  const {
    to,
    subject,
    text,
    html,
    replyToMessageId,
    sendAt,
    requestId,
    followUpAt,
    attachmentIds: rawAttachmentIds,
  } = body;
  // Optional client-generated id for idempotency; bounded and restricted so
  // it can only widen the key space, never collide or smuggle content.
  const requestIdText = String(requestId ?? '');
  const clientRequestId = /^[A-Za-z0-9._:-]{1,128}$/.test(requestIdText) ? requestIdText : null;
  const validated = validateOutboundMessage({ to, subject, text, html });
  if (validated.error || !validated.recipients) {
    return Response.json({ error: validated.error }, { status: 400 });
  }
  const { recipients, bodyHtml } = validated;
  const attachmentIds = parseAttachmentIds(rawAttachmentIds);
  if (attachmentIds === null) {
    return Response.json(
      { error: 'attachmentIds must be a unique list of valid ids' },
      { status: 400 },
    );
  }
  // Fixture ids from e2e/dev mode aren't UUIDs — ignore them rather than error.
  let replyTo = UUID_RE.test(replyToMessageId) ? String(replyToMessageId) : null;

  if (sendAt !== undefined) {
    const scheduledFor = parseScheduledFor(sendAt);
    if (!scheduledFor) {
      return Response.json(
        { error: 'sendAt must be an ISO timestamp at least a minute out' },
        { status: 400 },
      );
    }
    const parsedFollowUpAt =
      followUpAt === null || followUpAt === undefined
        ? null
        : parseFollowUpAt(followUpAt, scheduledFor);
    if (followUpAt !== null && followUpAt !== undefined && !parsedFollowUpAt) {
      return Response.json(
        { error: 'followUpAt must be an ISO timestamp at least a minute after sendAt' },
        { status: 400 },
      );
    }
    try {
      const owned = await ownedReplyToMessageId(sql, userId, replyTo);
      if (owned.missing) {
        return Response.json({ error: 'Reply target not found' }, { status: 404 });
      }
      const resolved = await resolveOwnedAttachments(sql, userId, attachmentIds);
      if (resolved.missing) {
        return Response.json({ error: 'Attachment not found' }, { status: 404 });
      }
      if (resolved.invalid || resolved.tooLarge) {
        return Response.json({ error: 'Attachments exceed the allowed size' }, { status: 400 });
      }
      const scheduledSend = await createScheduledSend(sql, userId, {
        recipients,
        subject,
        text,
        html: bodyHtml,
        replyToMessageId: owned.replyTo ?? null,
        scheduledFor,
        attachments: resolved.attachments,
        followUpAt: parsedFollowUpAt,
        requestId: clientRequestId,
      });
      if (!scheduledSend) {
        return Response.json({ error: 'Too many pending scheduled sends' }, { status: 429 });
      }
      return Response.json({ scheduledSend }, { status: 201 });
    } catch (err) {
      if (/** @type {{code?: string}} */ (err).code === 'IDEMPOTENCY_CONFLICT')
        return Response.json(
          { error: 'Request id already used for a different scheduled email' },
          { status: 409 },
        );
      console.error('POST /send (schedule) failed:', err);
      return Response.json({ error: 'Failed to schedule email' }, { status: 500 });
    }
  }

  let attachments;
  const parsedFollowUpAt =
    followUpAt === null || followUpAt === undefined ? null : parseFollowUpAt(followUpAt);
  if (followUpAt !== null && followUpAt !== undefined && !parsedFollowUpAt) {
    return Response.json(
      { error: 'followUpAt must be an ISO timestamp at least a minute out' },
      { status: 400 },
    );
  }
  try {
    const owned = await ownedReplyToMessageId(sql, userId, replyTo);
    if (owned.missing) {
      return Response.json({ error: 'Reply target not found' }, { status: 404 });
    }
    replyTo = owned.replyTo ?? null;
    const resolved = await resolveOwnedAttachments(sql, userId, attachmentIds);
    if (resolved.missing) {
      return Response.json({ error: 'Attachment not found' }, { status: 404 });
    }
    if (resolved.invalid || resolved.tooLarge) {
      return Response.json({ error: 'Attachments exceed the allowed size' }, { status: 400 });
    }
    attachments = resolved.attachments;
    const quota = await claimOutboundEmailQuota(sql, userId);
    if (!quota.authorized) {
      return Response.json({ error: 'Mailbox access is not provisioned' }, { status: 403 });
    }
    if (!quota.quota_claimed) {
      return Response.json(
        { error: 'Outbound email quota exceeded; try again shortly' },
        { status: 429 },
      );
    }
  } catch (err) {
    console.error('failed to enforce outbound email quota:', /** @type {Error} */ (err).message);
    return Response.json({ error: 'Email sending is temporarily unavailable' }, { status: 503 });
  }

  try {
    const { resendId, messageUuid, inserted } = await deliverMail(
      sql,
      userId,
      {
        recipients,
        subject,
        text,
        html: bodyHtml,
        replyToMessageId: replyTo,
        followUpAt: parsedFollowUpAt,
        idempotencyKey: await immediateSendIdempotencyKey(userId, {
          recipients,
          subject,
          text,
          html: bodyHtml,
          replyToMessageId: replyTo,
          attachmentIds,
          requestId: clientRequestId,
        }),
        attachments,
      },
      services,
    );
    // Off the response path on purpose: the sent copy is searchable within
    // seconds, and a Meilisearch outage only leaves search_indexed_at NULL for
    // the background drift sweep to repair.
    if (inserted && messageUuid) services.indexSentMessage(messageUuid);
    return Response.json({
      id: resendId,
      messageId: messageUuid,
      followUpScheduled: parsedFollowUpAt ? Boolean(messageUuid) : undefined,
    });
  } catch (err) {
    console.error('Resend send failed:', err);
    // The quota was claimed but no email was delivered — refund it so a
    // provider outage doesn't lock the user out of sending for the minute.
    await refundOutboundEmailQuota(sql, userId);
    return Response.json({ error: 'Failed to send email' }, { status: 502 });
  }
}

/**
 * GET/DELETE /send/scheduled — list or cancel the authenticated user's own
 * pending (or recently failed) scheduled sends.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {Request} request
 */
async function handleScheduled(sql, userId, request) {
  if (request.method === 'GET') {
    const scheduledSends = await listScheduledSends(sql, userId);
    return Response.json({ scheduledSends });
  }
  if (request.method === 'DELETE') {
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const errorResponse = bodyErrorResponse(error);
      if (errorResponse) return errorResponse;
      throw error;
    }
    const id = UUID_RE.test(body.id) ? String(body.id) : null;
    if (!id) {
      return Response.json({ error: 'id is required' }, { status: 400 });
    }
    const scheduledSend = await cancelScheduledSend(sql, userId, id);
    if (!scheduledSend) {
      return Response.json({ error: 'Scheduled send not found or already sent' }, { status: 404 });
    }
    return Response.json({ scheduledSend });
  }
  return Response.json(
    { error: 'Method not allowed' },
    { status: 405, headers: { Allow: 'GET, DELETE' } },
  );
}

const worker = {
  /**
   * Routes POST /send, GET/DELETE /send/scheduled (was ?resource=scheduled),
   * and POST /send/flush (was ?resource=flush). The flush job authenticates
   * with its own bearer secret, not a user Auth0 token, so it is dispatched
   * before verifyAccessToken runs.
   *
   * @param {Request} request
   * @param {import('./sentry.js').SendEnv} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return preflightResponse(origin, env.ALLOWED_ORIGIN, env.SENTRY_ENVIRONMENT);
    }

    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const resource =
      segments[0] === 'send' && segments.length <= 2 ? (segments[1] ?? 'send') : null;
    const services = createSendServices(env, ctx);
    const sql = createSql(env.HYPERDRIVE.connectionString);
    try {
      if (!resource || !['send', 'scheduled', 'flush', 'follow-up'].includes(resource)) {
        return Response.json({ error: 'Not Found' }, { status: 404 });
      }

      if (resource === 'flush') {
        if (request.method !== 'POST') {
          return Response.json(
            { error: 'Method not allowed' },
            { status: 405, headers: { Allow: 'POST' } },
          );
        }
        const token = env.SCHEDULED_SEND_FLUSH_TOKEN;
        const authorized =
          Boolean(token) &&
          (await timingSafeEqualStrings(request.headers.get('Authorization'), `Bearer ${token}`));
        if (!authorized) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        if (!sendingConfigured(env)) {
          return Response.json({ error: 'Email sending is not configured' }, { status: 503 });
        }
        return await handleFlush(sql, services);
      }

      let userId;
      try {
        ({ userId } = await verifyAccessToken(request, env, sql));
      } catch (error) {
        return withCors(
          authFailureResponse(error),
          origin,
          env.ALLOWED_ORIGIN,
          env.SENTRY_ENVIRONMENT,
        );
      }

      let response;
      try {
        if (resource === 'follow-up') {
          response = await handleFollowUp(sql, userId, request);
        } else if (resource === 'scheduled') {
          response = await handleScheduled(sql, userId, request);
        } else {
          if (request.method !== 'POST') {
            response = Response.json(
              { error: 'Method not allowed' },
              { status: 405, headers: { Allow: 'POST' } },
            );
          } else {
            response = await handleSend(sql, userId, request, services);
          }
        }
      } catch (err) {
        console.error(`${request.method} /send failed:`, err);
        captureHandledException('send', err, env, {
          path: url.pathname,
          method: request.method,
        });
        response = Response.json({ error: 'Failed to send email' }, { status: 500 });
      }
      return withCors(response, origin, env.ALLOWED_ORIGIN, env.SENTRY_ENVIRONMENT);
    } catch (error) {
      console.log(
        JSON.stringify({ event: 'request_failed', path: url.pathname, method: request.method }),
      );
      captureHandledException('fetch', error, env, { path: url.pathname, method: request.method });
      return withCors(
        Response.json({ error: 'Request failed' }, { status: 500 }),
        origin,
        env.ALLOWED_ORIGIN,
        env.SENTRY_ENVIRONMENT,
      );
    } finally {
      ctx.waitUntil(sql.end({ timeout: 2 }).catch(() => undefined));
    }
  },
};

export default Sentry.withSentry(createSentryOptions, worker);
