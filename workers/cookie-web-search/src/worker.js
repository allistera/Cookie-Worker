import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { handleSearch } from './search.js';
import { handleAsk } from './ask.js';
import { captureHandledException, createSentryOptions } from './sentry.js';

import { configureOpenAi } from '../../../shared/openai.js';
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
 * Routes GET /search and POST /ask — Cookie-Web's api/search.js and
 * api/ask.js, sharing this Worker because they share Meilisearch retrieval
 * (queryParse/meili) and, for ask, the 'ai' quota. Quota is claimed inside
 * handleAsk, not here: search never spends AI quota (Meilisearch embeds
 * server-side), and ask validates its body first — both orderings are
 * load-bearing and match the originals.
 *
 * @param {URL} url
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {import('./sentry.js').SearchEnv} env
 */
async function route(url, request, sql, userId, env) {
  const segments = url.pathname.split('/').filter(Boolean);
  const resource = segments.length === 1 ? segments[0] : null;

  if (resource === 'search') {
    if (request.method !== 'GET') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET' } },
      );
    }
    return handleSearch(sql, userId, url, env);
  }

  if (resource === 'ask') {
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
    return handleAsk(sql, userId, body, env);
  }

  return Response.json({ error: 'Not Found' }, { status: 404 });
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').SearchEnv} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    configureOpenAi(env);
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

      const response = await route(url, request, sql, userId, env);
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
  withRequestMetrics(worker, 'cookie-web-search'),
);
