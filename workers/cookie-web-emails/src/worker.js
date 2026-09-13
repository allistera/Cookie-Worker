import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { handleList, handleState } from './emails.js';
import { getSpamRetention, putSpamRetention } from './spamRetention.js';
import { getAutoArchive, putAutoArchive } from './autoArchive.js';
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
 * Routes GET /emails, /emails/state and GET/PUT /emails/spam-retention — the resources Cookie-Web's
 * api/emails.js served, previously reached as /api/emails and
 * /api/emails?resource=state.
 *
 * @param {URL} url
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
async function route(url, request, sql, userId) {
  const segments = url.pathname.split('/').filter(Boolean);
  const sub = segments.length === 2 ? segments[1] : null;
  const isState = sub === 'state';
  const isSpamRetention = sub === 'spam-retention';
  const isAutoArchive = sub === 'auto-archive';
  if (
    segments[0] !== 'emails' ||
    (segments.length > 1 && !isState && !isSpamRetention && !isAutoArchive)
  ) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
  if (isSpamRetention || isAutoArchive) {
    if (request.method === 'GET')
      return isAutoArchive ? getAutoArchive(sql, userId) : getSpamRetention(sql, userId);
    if (request.method !== 'PUT') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, PUT' } },
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
    return isAutoArchive ? putAutoArchive(sql, userId, body) : putSpamRetention(sql, userId, body);
  }
  if (request.method !== 'GET') {
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET' } },
    );
  }
  return isState ? handleState(sql, userId) : handleList(sql, userId, url);
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').EmailsEnv} env
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

      const response = await route(url, request, sql, userId);
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

export default Sentry.withSentry(
  createSentryOptions,
  withRequestMetrics(worker, 'cookie-web-emails'),
);
