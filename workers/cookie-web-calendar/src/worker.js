import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import { createSql, endSql, withUserSql } from '../../../shared/db.js';
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
  setDefaultCalendar,
  syncCalendar,
} from './calendars.js';
import { captureHandledException, createSentryOptions } from './sentry.js';
import { CALLBACK_PATH } from './googleAuth.js';
import {
  authorizeGoogle,
  disconnectGoogle,
  getGoogleStatus,
  handleGoogleCallback,
  updateGoogleSelection,
} from './googleCalendar.js';

import { configureOpenAi } from '../../../shared/openai.js';
import { calendarAvailability } from './calendarAvailability.js';

/**
 * Routes GET/POST/PATCH/DELETE /calendar-events and /calendars — Cookie-Web's
 * api/calendar-events.js and its ?resource=calendars sub-handler, each as its
 * own clean route. POST /calendar-events with action=interpret is the AI
 * natural-language path; POST /calendars with action=sync is a manual
 * subscription re-sync, and PATCH /calendars with defaultCalendarId saves
 * the calendar new events go to. /google-calendar manages the Google Calendar
 * connection Settings offers (status, authorize, calendar selection,
 * disconnect); Google's own redirect lands on CALLBACK_PATH, handled
 * before auth in fetch() below.
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
  if (
    resource !== 'calendar-events' &&
    resource !== 'calendars' &&
    resource !== 'calendar-availability' &&
    resource !== 'google-calendar'
  ) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }

  if (resource === 'calendar-availability' && request.method !== 'POST') {
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    );
  }

  if (request.method === 'GET') {
    if (resource === 'google-calendar') return getGoogleStatus(sql, userId, env);
    return resource === 'calendar-events'
      ? listEvents(sql, userId, url, env)
      : listCalendars(sql, userId, env);
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

  if (resource === 'calendar-availability') return calendarAvailability(sql, userId, body, env);

  if (resource === 'google-calendar') {
    if (request.method === 'POST' && body.action === 'authorize') {
      return authorizeGoogle(sql, userId, body, url, env);
    }
    if (request.method === 'POST') {
      return Response.json({ error: 'Unsupported action' }, { status: 400 });
    }
    if (request.method === 'PATCH') return updateGoogleSelection(sql, userId, body, env);
    return disconnectGoogle(sql, userId, env);
  }

  if (resource === 'calendar-events') {
    if (request.method === 'POST' && body.action === 'interpret') {
      return interpretEvent(sql, userId, body, env);
    }
    if (request.method === 'POST') return createEvent(sql, userId, body, env);
    if (request.method === 'PATCH') return updateEvent(sql, userId, body, env);
    return deleteEvent(sql, userId, body, env);
  }

  if (request.method === 'POST' && body.action === 'sync') {
    return (await claimSyncQuota(sql, userId)) ?? syncCalendar(sql, userId, body, env);
  }
  if (request.method === 'POST' && body.subscriptionUrl) {
    return (await claimSyncQuota(sql, userId)) ?? createCalendar(sql, userId, body, env);
  }
  if (request.method === 'POST') return createCalendar(sql, userId, body, env);
  if (request.method === 'PATCH') {
    return 'defaultCalendarId' in body
      ? setDefaultCalendar(sql, userId, body, env)
      : renameCalendar(sql, userId, body);
  }
  return deleteCalendar(sql, userId, body);
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').CalendarEnv} env
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
      // Google redirects the browser here after sign-in. A top-level
      // navigation carries no Auth0 bearer token; the single-use state it
      // carries was bound to the signed-in user when the flow began
      // (googleAuth.js), which is what authenticates it instead.
      if (request.method === 'GET' && url.pathname === CALLBACK_PATH) {
        const sql = createSql(env.HYPERDRIVE.connectionString);
        try {
          return await handleGoogleCallback(sql, url, env);
        } finally {
          ctx.waitUntil(endSql(sql));
        }
      }

      // Reads are idempotent, so a dropped Hyperdrive connection gets one more
      // go on a fresh client. Writes (and the AI/sync POSTs) are not retried.
      const response = await withUserSql(
        request,
        env,
        ctx,
        { retryable: request.method === 'GET' || request.method === 'HEAD' },
        (sql, userId) => route(url, request, sql, userId, env),
      );
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
                : url.pathname.startsWith('/google-calendar')
                  ? 'Google Calendar request failed'
                  : 'Calendar events request failed',
          },
          { status: 500 },
        ),
        origin,
        env.ALLOWED_ORIGIN,
        env.SENTRY_ENVIRONMENT,
      );
    }
  },
};

export default Sentry.withSentry(
  createSentryOptions,
  withRequestMetrics(worker, 'cookie-web-calendar'),
);
