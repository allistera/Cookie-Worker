import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { clientIp, handlePixel, handleStatus } from './readReceipts.js';
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

const worker = {
  /**
   * Routes GET /read-receipts — the same endpoint Cookie-Web's
   * api/read-receipts.js served, with the same split personality:
   * `?token=` is the unauthenticated tracking pixel embedded in sent mail
   * (auth MUST NOT run — recipients hold no token, and the response must be
   * identical either way), while `?messageIds=` is the SPA's authenticated
   * receipt-status read.
   *
   * @param {Request} request
   * @param {import('./sentry.js').ReceiptsEnv} env
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
      if (url.pathname !== '/read-receipts') {
        return withCors(
          Response.json({ error: 'Not Found' }, { status: 404 }),
          origin,
          env.ALLOWED_ORIGIN,
          env.SENTRY_ENVIRONMENT,
        );
      }
      if (request.method !== 'GET') {
        return withCors(
          Response.json(
            { error: 'Method not allowed' },
            { status: 405, headers: { Allow: 'GET' } },
          ),
          origin,
          env.ALLOWED_ORIGIN,
          env.SENTRY_ENVIRONMENT,
        );
      }

      const token = url.searchParams.get('token');
      if (token !== null) {
        // The pixel needs no CORS: email clients load it as an image, and the
        // response never varies, so there is nothing to gate on Origin.
        return await handlePixel(sql, token, clientIp(request));
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

      const response = await handleStatus(sql, userId, url);
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
