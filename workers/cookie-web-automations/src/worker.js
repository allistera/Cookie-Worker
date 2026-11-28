import { withApplicationMetrics } from '../../../shared/applicationMetrics.js';
import { withSqlMetrics } from '../../../shared/sqlMetrics.js';
import { withResponseMetrics } from '../../../shared/responseMetrics.js';
import { withHealthCheck } from '../../../shared/health.js';
import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { createSql, withUserSql } from '../../../shared/db.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  listRuns,
  runAutomationNow,
  updateAutomation,
} from './automations.js';
import { runDueAutomations } from './runner.js';
import { captureHandledException, createSentryOptions, tagTrigger } from './sentry.js';

const SERVICE = 'cookie-web-automations';

/**
 * The bindings a run uses. Wrangler types a service binding as a plain
 * fetcher; the entrypoint's `call` method is declared in handlers.js.
 *
 * @param {import('./sentry.js').AutomationsEnv} env
 * @returns {import('./runner.js').RunnerEnv}
 */
function runnerEnv(env) {
  return {
    TASKS: /** @type {import('./handlers.js').InternalService} */ (
      /** @type {unknown} */ (env.TASKS)
    ),
  };
}

/** @param {string} allow */
function methodNotAllowed(allow) {
  return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: allow } });
}

/**
 * @param {URL} url
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {import('./sentry.js').AutomationsEnv} env
 */
async function route(url, request, sql, userId, env) {
  const { pathname } = url;
  const { method } = request;
  if (pathname === '/automation-runs') {
    return method === 'GET' ? listRuns(sql, userId) : methodNotAllowed('GET');
  }
  if (pathname !== '/automations' && pathname !== '/automations/run') {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
  if (pathname === '/automations' && method === 'GET') return listAutomations(sql, userId);
  const allowed = pathname === '/automations' ? ['POST', 'PATCH', 'DELETE'] : ['POST'];
  if (!allowed.includes(method)) {
    return methodNotAllowed(pathname === '/automations' ? 'GET, POST, PATCH, DELETE' : 'POST');
  }

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
  const now = new Date();
  if (pathname === '/automations/run') {
    return runAutomationNow(sql, userId, body, runnerEnv(env), now, (operation, error, extra) =>
      captureHandledException(operation, error, env, extra),
    );
  }
  if (method === 'POST') return createAutomation(sql, userId, body, now);
  if (method === 'PATCH') return updateAutomation(sql, userId, body, now);
  return deleteAutomation(sql, userId, body);
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').AutomationsEnv} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    tagTrigger('http');
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

  /**
   * The cron tick: runs every automation whose schedule has come due.
   *
   * @param {ScheduledController} controller
   * @param {import('./sentry.js').AutomationsEnv} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(controller, env, ctx) {
    tagTrigger('scheduled');
    const sql = createSql(env.HYPERDRIVE.connectionString);
    ctx.waitUntil(
      runDueAutomations(
        sql,
        runnerEnv(env),
        new Date(controller.scheduledTime),
        (operation, error, extra) => captureHandledException(operation, error, env, extra),
      )
        .catch((error) => captureHandledException('scheduled', error, env))
        .finally(() => sql.end({ timeout: 2 }).catch(() => undefined)),
    );
  },
};

export default Sentry.withSentry(
  createSentryOptions,
  withApplicationMetrics(
    withSqlMetrics(
      withResponseMetrics(withRequestMetrics(withHealthCheck(worker), SERVICE), SERVICE),
      SERVICE,
    ),
    SERVICE,
  ),
);
