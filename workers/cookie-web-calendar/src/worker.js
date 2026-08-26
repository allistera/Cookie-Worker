import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
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
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
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
    return (await claimSyncQuota(sql, userId)) ?? syncCalendar(sql, userId, body);
  }
  if (request.method === 'POST' && body.subscriptionUrl) {
    return (await claimSyncQuota(sql, userId)) ?? createCalendar(sql, userId, body);
  }
  if (request.method === 'POST') return createCalendar(sql, userId, body);
  if (request.method === 'PATCH') return renameCalendar(sql, userId, body);
  return deleteCalendar(sql, userId, body);
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').CalendarEnv} env
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
      await sql.end({ timeout: 2 }).catch(() => undefined);
    }
  },
};

export default Sentry.withSentry(createSentryOptions, worker);
