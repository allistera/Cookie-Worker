import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import { withUserSql } from '../../../shared/db.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { allowRequest } from '../../../shared/rate-limit.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { createDraft, deleteDraft, getDraft, listDrafts, updateDraft } from './drafts.js';
import { captureHandledException, createSentryOptions } from './sentry.js';

// Autosave is a write per ~800ms of typing pause, per open composer. This is
// deliberately generous enough never to interrupt real writing, and low enough
// that a stuck client cannot rewrite the same row without bound.
const AUTOSAVE_RATE_LIMIT = { limit: 120, windowMs: 60_000 };

// A draft body carries the whole composed message, so the shared 64KB default
// is too small: MAX_OUTBOUND_HTML_BYTES alone is 200KB.
const MAX_DRAFT_BODY_BYTES = 400 * 1024;

/**
 * Routes /drafts and /drafts/:id.
 *
 * @param {URL} url
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
async function route(url, request, sql, userId) {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'drafts' || segments.length > 2) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
  const id = segments[1] ?? null;

  if (request.method === 'GET') {
    return id ? getDraft(sql, userId, id) : listDrafts(sql, userId);
  }
  if (request.method === 'DELETE') {
    if (!id) {
      return Response.json({ error: 'A draft id is required' }, { status: 400 });
    }
    return deleteDraft(sql, userId, id);
  }

  const isCreate = request.method === 'POST' && !id;
  const isUpdate = request.method === 'PATCH' && id;
  if (!isCreate && !isUpdate) {
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET, POST, PATCH, DELETE' } },
    );
  }

  const allowed = await allowRequest(sql, userId, 'drafts-autosave', AUTOSAVE_RATE_LIMIT);
  if (!allowed) {
    return Response.json({ error: 'Too many draft saves, slow down' }, { status: 429 });
  }

  let body;
  try {
    body = await readJsonBody(request, { maxBytes: MAX_DRAFT_BODY_BYTES });
  } catch (error) {
    const errorResponse = bodyErrorResponse(error);
    if (errorResponse) return errorResponse;
    throw error;
  }

  return isCreate ? createDraft(sql, userId, body) : updateDraft(sql, userId, id, body);
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').DraftsEnv} env
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
      // go on a fresh client. Writes are not retried since PATCH autosave
      // would double-count its rate-limit counter.
      const response = await withUserSql(
        request,
        env,
        ctx,
        { retryable: request.method === 'GET' },
        (sql, userId) => route(url, request, sql, userId),
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
  withRequestMetrics(worker, 'cookie-web-drafts'),
);
