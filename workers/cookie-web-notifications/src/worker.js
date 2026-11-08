import { withApplicationMetrics } from '../../../shared/applicationMetrics.js';
import { withResponseMetrics } from '../../../shared/responseMetrics.js';
import { withHealthCheck } from '../../../shared/health.js';
import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { createSql, withUserSql } from '../../../shared/db.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { handleNotificationEvent } from './notificationEvents.js';
import {
  createNtfySubscription,
  DEFAULT_BASE_URL,
  deliverPendingNtfy,
  disableNtfySubscription,
  getNtfySubscription,
  NtfyPublishError,
  NtfySettingsError,
  saveNtfySubscription,
  sendNtfyTest,
} from './ntfy.js';
import { captureHandledException, createSentryOptions } from './sentry.js';

/**
 * Routes POST /notification-event — the single endpoint Cookie-Web's
 * api/notification-event.js served — and the ntfy settings under /ntfy.
 *
 * @param {URL} url
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{baseUrl: string, tokenKey?: string}} ntfy
 */
async function route(url, request, sql, userId, ntfy) {
  if (url.pathname === '/ntfy/test') {
    if (request.method !== 'POST') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'POST' } },
      );
    }
    try {
      return Response.json(await sendNtfyTest(sql, userId, ntfy));
    } catch (error) {
      if (error instanceof Error && error.message === 'ntfy subscription is not enabled') {
        return Response.json({ error: 'ntfy notifications are not enabled' }, { status: 409 });
      }
      if (error instanceof NtfyPublishError) {
        const rateLimited = error.status === 429;
        const unavailable = error.status >= 500;
        const headers =
          (rateLimited || unavailable) && error.retryAfterSeconds !== null
            ? { 'Retry-After': String(error.retryAfterSeconds) }
            : undefined;
        return Response.json(
          rateLimited
            ? { error: 'ntfy_rate_limited', retryAfterSeconds: error.retryAfterSeconds }
            : { error: unavailable ? 'ntfy_unavailable' : 'ntfy_rejected' },
          { status: rateLimited || unavailable ? 503 : 502, headers },
        );
      }
      throw error;
    }
  }
  if (url.pathname === '/ntfy') {
    if (request.method === 'GET') {
      return Response.json(await getNtfySubscription(sql, userId, ntfy), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    // PUT saves the server, topic and token Settings sent; POST is the older
    // switch-only setup (a generated topic on the default server), kept for
    // a web client deployed before the form existed.
    if (request.method === 'PUT') {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        const errorResponse = bodyErrorResponse(error);
        if (errorResponse) return errorResponse;
        throw error;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return Response.json({ error: 'Expected a JSON object' }, { status: 400 });
      }
      try {
        return Response.json(await saveNtfySubscription(sql, userId, body, ntfy), {
          headers: { 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        if (error instanceof NtfySettingsError) {
          const status =
            error.code === 'topic_taken' ? 409 : error.code === 'tokens_not_configured' ? 501 : 400;
          return Response.json({ error: error.code, message: error.message }, { status });
        }
        throw error;
      }
    }
    if (request.method === 'POST') {
      return Response.json(await createNtfySubscription(sql, userId, ntfy), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (request.method === 'DELETE') {
      await disableNtfySubscription(sql, userId);
      return new Response(null, { status: 204 });
    }
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET, PUT, POST, DELETE' } },
    );
  }
  if (url.pathname !== '/notification-event') {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
  if (request.method !== 'POST') {
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    );
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const errorResponse = bodyErrorResponse(error);
    if (errorResponse) return errorResponse;
    throw error;
  }
  return handleNotificationEvent(sql, userId, body);
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').NotificationsEnv} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return preflightResponse(origin, env.ALLOWED_ORIGIN, env.SENTRY_ENVIRONMENT);
    }

    const url = new URL(request.url);
    try {
      // Reads are idempotent, so a dropped Hyperdrive connection gets one more
      // go on a fresh client. Writes are not retried.
      const response = await withUserSql(
        request,
        env,
        ctx,
        { retryable: request.method === 'GET' || request.method === 'HEAD' },
        (sql, userId) =>
          route(url, request, sql, userId, {
            baseUrl: env.NTFY_BASE_URL || DEFAULT_BASE_URL,
            tokenKey: env.NTFY_TOKEN_ENCRYPTION_KEY,
          }),
      );
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
    }
  },

  /** @param {ScheduledController} _controller @param {import('./sentry.js').NotificationsEnv} env @param {ExecutionContext} ctx */
  async scheduled(_controller, env, ctx) {
    const sql = createSql(env.HYPERDRIVE.connectionString);
    ctx.waitUntil(
      deliverPendingNtfy(sql, {
        baseUrl: env.NTFY_BASE_URL || DEFAULT_BASE_URL,
        tokenKey: env.NTFY_TOKEN_ENCRYPTION_KEY,
      }).finally(() => sql.end({ timeout: 2 }).catch(() => undefined)),
    );
  },
};

export default Sentry.withSentry(
  createSentryOptions,
  withApplicationMetrics(
    withResponseMetrics(
      withRequestMetrics(withHealthCheck(worker), 'cookie-web-notifications'),
      'cookie-web-notifications',
    ),
    'cookie-web-notifications',
  ),
);
