import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { Resend } from 'resend';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { timingSafeEqualStrings } from '../../../shared/auth.js';
import { embedText } from '../../../shared/embeddings.js';
import {
  EMBEDDING_MODEL,
  deliverMail,
  immediateSendIdempotencyKey,
  claimOutboundEmailQuota,
  ownedReplyToMessageId,
  refundOutboundEmailQuota,
  validateOutboundMessage,
} from './outbound.js';
import {
  cancelScheduledSend,
  createScheduledSend,
  handleFlush,
  listScheduledSends,
  parseScheduledFor,
} from './scheduled.js';
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
 * Builds the per-request delivery seams. queueEmbedding runs the sent-mail
 * embedding after the response via ctx.waitUntil, on its own short-lived
 * database connection — the request's connection is closed by then.
 *
 * @param {import('./sentry.js').SendEnv} env
 * @param {ExecutionContext} ctx
 * @returns {import('./outbound.js').SendServices}
 */
export function createSendServices(env, ctx) {
  return {
    env,
    createResend: (apiKey) => new Resend(apiKey),
    embedText,
    queueEmbedding(messageUuid, content) {
      ctx.waitUntil(
        (async () => {
          const sql = createSql(env.HYPERDRIVE.connectionString);
          try {
            const vector = await embedText(content, /** @type {string} */ (env.OPENAI_API_KEY));
            await sql`
              UPDATE messages
              SET embedding = ${JSON.stringify(vector)}::extensions.vector, embedding_model = ${EMBEDDING_MODEL}
              WHERE id = ${messageUuid} AND embedding IS NULL
            `;
          } catch (err) {
            console.error('sent-message embedding failed:', /** @type {Error} */ (err).message);
          } finally {
            await sql.end({ timeout: 2 }).catch(() => undefined);
          }
        })(),
      );
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

  const { to, subject, text, html, replyToMessageId, sendAt, requestId } = body;
  // Optional client-generated id for idempotency; bounded and restricted so
  // it can only widen the key space, never collide or smuggle content.
  const requestIdText = String(requestId ?? '');
  const clientRequestId = /^[A-Za-z0-9._:-]{1,128}$/.test(requestIdText) ? requestIdText : null;
  const validated = validateOutboundMessage({ to, subject, text, html });
  if (validated.error || !validated.recipients) {
    return Response.json({ error: validated.error }, { status: 400 });
  }
  const { recipients, bodyHtml } = validated;
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
    try {
      const owned = await ownedReplyToMessageId(sql, userId, replyTo);
      if (owned.missing) {
        return Response.json({ error: 'Reply target not found' }, { status: 404 });
      }
      const scheduledSend = await createScheduledSend(sql, userId, {
        recipients,
        subject,
        text,
        html: bodyHtml,
        replyToMessageId: owned.replyTo ?? null,
        scheduledFor,
      });
      if (!scheduledSend) {
        return Response.json({ error: 'Too many pending scheduled sends' }, { status: 429 });
      }
      return Response.json({ scheduledSend }, { status: 201 });
    } catch (err) {
      console.error('POST /send (schedule) failed:', err);
      return Response.json({ error: 'Failed to schedule email' }, { status: 500 });
    }
  }

  try {
    const owned = await ownedReplyToMessageId(sql, userId, replyTo);
    if (owned.missing) {
      return Response.json({ error: 'Reply target not found' }, { status: 404 });
    }
    replyTo = owned.replyTo ?? null;
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
    const { resendId } = await deliverMail(
      sql,
      userId,
      {
        recipients,
        subject,
        text,
        html: bodyHtml,
        replyToMessageId: replyTo,
        idempotencyKey: await immediateSendIdempotencyKey(userId, {
          recipients,
          subject,
          text,
          html: bodyHtml,
          replyToMessageId: replyTo,
          requestId: clientRequestId,
        }),
      },
      services,
    );
    return Response.json({ id: resendId });
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
      if (!resource || !['send', 'scheduled', 'flush'].includes(resource)) {
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
        if (resource === 'scheduled') {
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
