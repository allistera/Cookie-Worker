import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { withUserSql } from '../../../shared/db.js';
import { handleList, handleState } from './emails.js';
import { getSpamRetention, putSpamRetention } from './spamRetention.js';
import { getAutoArchive, putAutoArchive } from './autoArchive.js';
import { getComposePreferences, putComposePreferences } from './composePreferences.js';
import { getOutOfOffice, putOutOfOffice } from './outOfOffice.js';
import { getSenders, putSenders } from './senders.js';
import { captureHandledException, createSentryOptions } from './sentry.js';

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
  const isComposePreferences = sub === 'compose-preferences';
  const isOutOfOffice = sub === 'out-of-office';
  const isSenders = sub === 'senders';
  if (
    segments[0] !== 'emails' ||
    (segments.length > 1 &&
      !isState &&
      !isSpamRetention &&
      !isAutoArchive &&
      !isComposePreferences &&
      !isOutOfOffice &&
      !isSenders)
  ) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
  if (isSpamRetention || isAutoArchive || isComposePreferences || isOutOfOffice || isSenders) {
    if (request.method === 'GET')
      return isSenders
        ? getSenders(sql, userId, url)
        : isOutOfOffice
          ? getOutOfOffice(sql, userId)
          : isAutoArchive
            ? getAutoArchive(sql, userId)
            : isComposePreferences
              ? getComposePreferences(sql, userId)
              : getSpamRetention(sql, userId);
    if (request.method !== 'PUT') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, PUT' } },
      );
    }
    let body;
    try {
      body = await readJsonBody(
        request,
        isComposePreferences ? { maxBytes: 512 * 1024 } : undefined,
      );
    } catch (error) {
      const errorResponse = bodyErrorResponse(error);
      if (errorResponse) return errorResponse;
      throw error;
    }
    return isSenders
      ? putSenders(sql, userId, body)
      : isOutOfOffice
        ? putOutOfOffice(sql, userId, body)
        : isAutoArchive
          ? putAutoArchive(sql, userId, body)
          : isComposePreferences
            ? putComposePreferences(sql, userId, body)
            : putSpamRetention(sql, userId, body);
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
    try {
      // Reads are idempotent (GET /emails is the busiest one), so a dropped
      // Hyperdrive connection gets one more go on a fresh client. PUTs are
      // not retried.
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
  withRequestMetrics(worker, 'cookie-web-emails'),
);
