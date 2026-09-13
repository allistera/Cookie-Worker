import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { createCategory, deleteCategory, listCategories, updateCategory } from './categories.js';
import { createLabel, deleteLabel, listLabels, updateLabel } from './labels.js';
import { createRule, deleteRule, listRules, updateRule } from './labelRules.js';
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

const LABEL_HANDLERS = { POST: createLabel, PATCH: updateLabel, DELETE: deleteLabel };
const CATEGORY_HANDLERS = {
  POST: createCategory,
  PATCH: updateCategory,
  DELETE: deleteCategory,
};
const RULE_HANDLERS = { POST: createRule, PATCH: updateRule, DELETE: deleteRule };

/**
 * Routes GET/POST/PATCH/DELETE /labels, /labels/rules and /categories. Labels
 * and Categories share this metadata Worker but remain separate resources.
 * The first two are the same resources Cookie-Web's legacy api/labels.js and
 * api/_lib/label-rules.js served,
 * previously reached only via api/labels.js?resource=rules to stay under
 * Vercel Hobby's 12-function cap. That multiplexing is gone: this Worker has
 * no such limit, so /labels/rules is its own clean path.
 *
 * @param {URL} url
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
async function route(url, request, sql, userId) {
  const segments = url.pathname.split('/').filter(Boolean);
  const isCategories = segments.length === 1 && segments[0] === 'categories';
  const isRules = segments.length === 2 && segments[1] === 'rules';
  const isLabels = segments.length === 1 || isRules;
  if (!isCategories && (segments[0] !== 'labels' || !isLabels)) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }

  if (request.method === 'GET') {
    if (isCategories) return listCategories(sql, userId);
    return isRules ? listRules(sql, userId) : listLabels(sql, userId);
  }

  const handlers = isCategories ? CATEGORY_HANDLERS : isRules ? RULE_HANDLERS : LABEL_HANDLERS;
  const handler = handlers[/** @type {keyof typeof handlers} */ (request.method)];
  if (!handler) {
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET, POST, PATCH, DELETE' } },
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
  return handler(sql, userId, body);
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').LabelsEnv} env
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
  withRequestMetrics(worker, 'cookie-web-labels'),
);
