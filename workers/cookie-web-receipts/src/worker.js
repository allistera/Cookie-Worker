import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { createSql, withUserSql } from '../../../shared/db.js';
import { clientIp, handlePixel, handleStatus } from './readReceipts.js';
import { captureHandledException, createSentryOptions } from './sentry.js';

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
        // response never varies, so there is nothing to gate on Origin. The
        // open is recorded after the image is sent, on a client of its own.
        return handlePixel(
          () => createSql(env.HYPERDRIVE.connectionString),
          token,
          clientIp(request),
          ctx,
        );
      }

      // A status read is idempotent, so a dropped Hyperdrive connection gets
      // one more go on a fresh client.
      const response = await withUserSql(request, env, ctx, { retryable: true }, (sql, userId) =>
        handleStatus(sql, userId, url),
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
};

export default Sentry.withSentry(
  createSentryOptions,
  withRequestMetrics(worker, 'cookie-web-receipts'),
);
