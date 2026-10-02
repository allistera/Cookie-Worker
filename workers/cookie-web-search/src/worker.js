import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { withUserSql } from '../../../shared/db.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { handleSearch } from './search.js';
import { handleAsk } from './ask.js';
import { getSavedViews, putSavedViews } from './savedViews.js';
import { captureHandledException, createSentryOptions } from './sentry.js';

import { configureOpenAi } from '../../../shared/openai.js';

/**
 * Routes GET /search, GET/PUT /saved-views, and POST /ask — Cookie-Web's api/search.js and
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

  if (resource === 'saved-views') {
    if (request.method === 'GET') return getSavedViews(sql, userId);
    if (request.method !== 'PUT') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, PUT', 'Cache-Control': 'private, no-store' } },
      );
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const errorResponse = bodyErrorResponse(error);
      if (errorResponse) {
        errorResponse.headers.set('Cache-Control', 'private, no-store');
        return errorResponse;
      }
      throw error;
    }
    return putSavedViews(sql, userId, body);
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
    try {
      // Reads are idempotent, so a dropped Hyperdrive connection gets one more
      // go on a fresh client. Writes (and /ask, which spends AI quota) are not
      // retried.
      const response = await withUserSql(
        request,
        env,
        ctx,
        { retryable: request.method === 'GET' || request.method === 'HEAD' },
        (sql, userId) => route(url, request, sql, userId, env),
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
  withRequestMetrics(worker, 'cookie-web-search'),
);
