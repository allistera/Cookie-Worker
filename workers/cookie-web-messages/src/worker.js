import * as Sentry from '@sentry/cloudflare';
import { getDownloadUrl, issueSignedToken, presignUrl } from '@vercel/blob';
import postgres from 'postgres';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { getContacts } from './contacts.js';
import { getAttachment, getMessage, getThreadBody, patchMessage, postMessage } from './messages.js';
import { syncMessageToMeili } from '../../../shared/meiliSync.js';
import { sendEmail } from './resend.js';
import { requestPublicHttps, parseAllowlistOverride } from '../../../shared/safe-https.js';
import { captureHandledException, createSentryOptions } from './sentry.js';

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
 * Best-effort push of one just-changed message to Meilisearch, so an archive,
 * star, read, trash, snooze or label edit is reflected in search immediately
 * rather than waiting for the drift sweep to notice search_indexed_at is NULL.
 *
 * This runs on its OWN client, deliberately: `fetch` below closes the
 * request-scoped `sql` in its `finally` as soon as the route returns, so a
 * waitUntil still holding that connection would race the teardown and query a
 * closing client. syncMessageToMeili never throws, but the client is still
 * closed in a `finally` so a failure can't leak the connection either.
 *
 * syncMessageToMeili swallows its own failures; the outer catch only covers a
 * connection that could not be opened at all (createSql throws synchronously on
 * an invalid connection string), which must stay silent as far as the mail
 * mutation is concerned rather than surfacing as an unhandled rejection.
 *
 * @param {import('./sentry.js').MessagesEnv} env
 * @param {ExecutionContext} ctx
 * @param {string} messageId
 */
function reindexMessage(env, ctx, messageId) {
  ctx.waitUntil(
    (async () => {
      const syncSql = createSql(env.HYPERDRIVE.connectionString);
      try {
        await syncMessageToMeili(syncSql, env, messageId);
      } finally {
        await syncSql.end({ timeout: 2 }).catch(() => undefined);
      }
    })().catch((err) => {
      console.error('failed to index message for search:', /** @type {Error} */ (err).message);
    }),
  );
}

/**
 * Routes GET/POST/PATCH /messages, /messages/attachment, /messages/thread-body,
 * and /messages/contacts — the same resources Cookie-Web's api/messages.js
 * and api/_lib/contacts.js served, previously reached only via
 * api/messages.js?resource=(attachment|thread-body|contacts) to stay under
 * Vercel Hobby's 12-function cap. This Worker has no such limit, so each is
 * its own clean path.
 *
 * @param {URL} url
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {import('./sentry.js').MessagesEnv} env
 * @param {ExecutionContext} ctx
 */
async function route(url, request, sql, userId, env, ctx) {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'messages' || segments.length > 2) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
  const sub = segments[1];
  if (sub && !['attachment', 'thread-body', 'contacts'].includes(sub)) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }

  if (sub === 'contacts') {
    if (request.method !== 'GET')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET' } },
      );
    return getContacts(sql, userId);
  }

  if (request.method !== 'GET' && request.method !== 'PATCH' && request.method !== 'POST') {
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET, POST, PATCH' } },
    );
  }

  if (sub === 'attachment') {
    if (request.method !== 'GET')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET' } },
      );
    const id = url.searchParams.get('id');
    return getAttachment(sql, userId, id, {
      issueSignedToken,
      presignUrl,
      getDownloadUrl,
      token: env.BLOB_READ_WRITE_TOKEN,
    });
  }

  if (sub === 'thread-body') {
    if (request.method !== 'GET')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET' } },
      );
    return getThreadBody(sql, userId, url.searchParams.get('id'));
  }

  if (request.method === 'GET') {
    return getMessage(sql, userId, url.searchParams.get('id'));
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const errorResponse = bodyErrorResponse(error);
    if (errorResponse) return errorResponse;
    throw error;
  }

  const onMessageChanged = (/** @type {string} */ messageId) => reindexMessage(env, ctx, messageId);

  if (request.method === 'POST') {
    const allowlistOverride = parseAllowlistOverride(env.UNSUBSCRIBE_ONE_CLICK_ALLOWLIST);
    return postMessage(sql, userId, body, {
      requestPublicHttps,
      resendApiKey: env.RESEND_API_KEY,
      emailFrom: env.EMAIL_FROM,
      sendEmail,
      // Empty override falls back to the built-in ESP suffix list.
      oneClickAllowlist: allowlistOverride.length ? allowlistOverride : undefined,
      onMessageChanged,
    });
  }

  return patchMessage(sql, userId, body, { onMessageChanged });
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').MessagesEnv} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return preflightResponse(origin, env.ALLOWED_ORIGIN, env.SENTRY_ENVIRONMENT);
    }

    const url = new URL(request.url);
    const sql = createSql(env.HYPERDRIVE.connectionString);
    try {
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

      const response = await route(url, request, sql, userId, env, ctx);
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
