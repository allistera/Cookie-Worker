import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import {
  createEvent,
  deleteEvent,
  interpretEvent,
  listEvents,
  updateEvent,
} from './calendarEvents.js';
import {
  claimSyncQuota,
  createCalendar,
  deleteCalendar,
  isUndefinedTable,
  listCalendars,
  renameCalendar,
  syncCalendar,
} from './calendars.js';
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
 * Routes GET/POST/PATCH/DELETE /calendar-events and /calendars — Cookie-Web's
 * api/calendar-events.js and its ?resource=calendars sub-handler, each as its
 * own clean route. POST /calendar-events with action=interpret is the AI
 * natural-language path; POST /calendars with action=sync is a manual
 * subscription re-sync.
 *
 * @param {URL} url
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {import('./sentry.js').CalendarEnv} env
 */
async function route(url, request, sql, userId, env) {
  const segments = url.pathname.split('/').filter(Boolean);
  const resource = segments.length === 1 ? segments[0] : null;
  if (resource !== 'calendar-events' && resource !== 'calendars') {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }

  if (request.method === 'GET') {
    return resource === 'calendar-events'
      ? listEvents(sql, userId, url)
      : listCalendars(sql, userId);
  }
  if (request.method !== 'POST' && request.method !== 'PATCH' && request.method !== 'DELETE') {
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

  if (resource === 'calendar-events') {
    if (request.method === 'POST' && body.action === 'interpret') {
      return interpretEvent(sql, userId, body, env);
    }
    if (request.method === 'POST') return createEvent(sql, userId, body);
    if (request.method === 'PATCH') return updateEvent(sql, userId, body);
    return deleteEvent(sql, userId, body);
  }

  if (request.method === 'POST' && body.action === 'sync') {
    return (await claimSyncQuota(sql, userId)) ?? syncCalendar(sql, userId, body, env);
  }
  if (request.method === 'POST' && body.subscriptionUrl) {
    return (await claimSyncQuota(sql, userId)) ?? createCalendar(sql, userId, body, env);
  }
  if (request.method === 'POST') return createCalendar(sql, userId, body, env);
  if (request.method === 'PATCH') return renameCalendar(sql, userId, body);
  return deleteCalendar(sql, userId, body);
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').CalendarEnv} env
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

      const response = await route(url, request, sql, userId, env);
      return withCors(response, origin, env.ALLOWED_ORIGIN, env.SENTRY_ENVIRONMENT);
    } catch (error) {
      // /calendars kept working through the original table-creation rollout by
      // answering 503 while the migration was still landing; preserved here.
      if (url.pathname === '/calendars' && isUndefinedTable(error)) {
        return withCors(
          Response.json(
            { error: 'Calendar management is being upgraded. Try again shortly.' },
            { status: 503 },
          ),
          origin,
          env.ALLOWED_ORIGIN,
          env.SENTRY_ENVIRONMENT,
        );
      }
      console.log(
        JSON.stringify({ event: 'request_failed', path: url.pathname, method: request.method }),
      );
      captureHandledException('fetch', error, env, { path: url.pathname, method: request.method });
      return withCors(
        Response.json(
          {
            error:
              url.pathname === '/calendars'
                ? 'Calendars request failed'
                : 'Calendar events request failed',
          },
          { status: 500 },
        ),
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
