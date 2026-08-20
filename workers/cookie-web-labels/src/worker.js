import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { createLabel, deleteLabel, listLabels, updateLabel } from './labels.js';
import { createRule, deleteRule, listRules, updateRule } from './labelRules.js';
import { captureHandledException, createSentryOptions } from './sentry.js';

// Matches Cookie-Web's own api/_lib/body.js limit (Vercel's ~4.5 MB request
// body cap), so a request that would be rejected there behaves the same way
// here.
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

/** @param {Request} request */
async function readJsonBody(request) {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new Error('Request body too large');
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error('Request body too large');
  const raw = new TextDecoder().decode(bytes);
  return raw ? JSON.parse(raw) : {};
}

const LABEL_HANDLERS = { POST: createLabel, PATCH: updateLabel, DELETE: deleteLabel };
const RULE_HANDLERS = { POST: createRule, PATCH: updateRule, DELETE: deleteRule };

/**
 * Routes GET/POST/PATCH/DELETE /labels and /labels/rules — the same two
 * resources Cookie-Web's api/labels.js and api/_lib/label-rules.js served,
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
  const isRules = segments.length === 2 && segments[1] === 'rules';
  const isLabels = segments.length === 1 || isRules;
  if (segments[0] !== 'labels' || !isLabels) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }

  if (request.method === 'GET') {
    return isRules ? listRules(sql, userId) : listLabels(sql, userId);
  }

  const handlers = isRules ? RULE_HANDLERS : LABEL_HANDLERS;
  const handler = handlers[/** @type {keyof typeof handlers} */ (request.method)];
  if (!handler) {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  return handler(sql, userId, body);
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').LabelsEnv} env
   * @param {ExecutionContext} _ctx
   */
  async fetch(request, env, _ctx) {
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
      await sql.end({ timeout: 2 }).catch(() => undefined);
    }
  },
};

export default Sentry.withSentry(createSentryOptions, worker);
