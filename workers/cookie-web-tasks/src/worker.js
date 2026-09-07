import * as Sentry from '@sentry/cloudflare';
import { put } from '@vercel/blob';
import postgres from 'postgres';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { hybridSearch } from '../../../shared/meili.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { getDailyNoteSeed, putDailyNoteSeed } from './dailyNoteSeed.js';
import { createDocument, deleteDocument, getDocuments, updateDocument } from './documents.js';
import { getEnrichmentSettings, putEnrichmentSettings } from './enrichmentSettings.js';
import { postImageUpload } from './imageUpload.js';
import { getInterests, putInterests } from './interests.js';
import { createProject, deleteProject, getProjects, updateProject } from './projects.js';
import { allowRequest } from './rateLimit.js';
import { postRefresh } from './refresh.js';
import { captureHandledException, createSentryOptions } from './sentry.js';
import {
  createTaskItem,
  deleteTaskItem,
  getTaskItems,
  reorderTaskItems,
  updateTaskItem,
} from './taskItems.js';
import { interpretTask } from './taskAi.js';
import { getTasks, postTasks } from './tasks.js';

// Vercel's body cap is 4.5 MB; keep that for document payloads, but use a much
// smaller default for the ordinary command endpoints this Worker serves.
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

/**
 * Routes GET/POST /tasks, POST /tasks/refresh, GET/PUT /tasks/interests,
 * GET/PUT /tasks/enrichment-settings,
 * POST /task-items/reorder, POST /task-items/interpret,
 * GET/PUT /tasks/daily-note-seed, POST /tasks/image-upload, and
 * GET/POST/PATCH/DELETE /documents — the resources Cookie-Web's api/tasks.js
 * served, previously reached only via
 * api/tasks.js?resource=(refresh|interests|documents|daily-note-seed|image-upload)
 * to stay under Vercel Hobby's 12-function cap. This Worker has no such
 * limit, so each is its own clean path.
 *
 * @param {URL} url
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {import('./sentry.js').TasksEnv} env
 * @param {string} [email] The verified caller's email (lowercased).
 */
async function route(url, request, sql, userId, env, email) {
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] === 'task-items') {
    const reorder = segments.length === 2 && segments[1] === 'reorder';
    const interpret = segments.length === 2 && segments[1] === 'interpret';
    if (segments.length > 1 && !reorder && !interpret) {
      return Response.json({ error: 'Not Found' }, { status: 404 });
    }
    if ((reorder || interpret) && request.method !== 'POST') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'POST' } },
      );
    }
    if (request.method === 'GET') return getTaskItems(sql, userId, url);
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
    if (interpret) return interpretTask(sql, userId, body, env);
    if (reorder) return reorderTaskItems(sql, userId, body);
    if (request.method === 'POST') return createTaskItem(sql, userId, body, env);
    if (request.method === 'PATCH') return updateTaskItem(sql, userId, body, env);
    return deleteTaskItem(sql, userId, body, env);
  }

  if (segments[0] === 'projects') {
    if (segments.length > 1) return Response.json({ error: 'Not Found' }, { status: 404 });
    if (request.method === 'GET') return getProjects(sql, userId);
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
    if (request.method === 'POST') return createProject(sql, userId, body);
    if (request.method === 'PATCH') return updateProject(sql, userId, body);
    return deleteProject(sql, userId, body);
  }

  if (segments[0] === 'documents') {
    if (segments.length > 1) return Response.json({ error: 'Not Found' }, { status: 404 });
    const deps = { env, hybridSearch };
    if (request.method === 'GET') return getDocuments(sql, userId, url, deps);
    if (request.method !== 'POST' && request.method !== 'PATCH' && request.method !== 'DELETE') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, POST, PATCH, DELETE' } },
      );
    }
    let body;
    try {
      body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    } catch (error) {
      const errorResponse = bodyErrorResponse(error);
      if (errorResponse) return errorResponse;
      throw error;
    }
    if (request.method === 'POST') return createDocument(sql, userId, body, deps, env);
    if (request.method === 'PATCH') return updateDocument(sql, userId, body, deps, env);
    return deleteDocument(sql, userId, body, env);
  }

  if (segments[0] !== 'tasks' || segments.length > 2) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
  const sub = segments[1];
  if (
    sub &&
    !['refresh', 'interests', 'enrichment-settings', 'daily-note-seed', 'image-upload'].includes(
      sub,
    )
  ) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }

  if (sub === 'refresh') {
    if (request.method !== 'POST')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'POST' } },
      );
    // The enricher rebuilds state for the fixed OWNER_EMAIL mailbox, so only
    // that owner may trigger it — any other provisioned account would be
    // spending the owner's AI budget and racing the owner's generated state.
    const ownerEmail = String(env.OWNER_EMAIL ?? '').toLowerCase();
    if (!ownerEmail || !email || email.toLowerCase() !== ownerEmail) {
      return Response.json({ error: 'Refresh is limited to the mailbox owner' }, { status: 403 });
    }
    return postRefresh(sql, userId, env.ENRICHER, env.ENRICHER_TRIGGER_TOKEN);
  }

  if (sub === 'enrichment-settings') {
    if (request.method !== 'GET' && request.method !== 'PUT') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, PUT' } },
      );
    }
    const ownerEmail = String(env.OWNER_EMAIL ?? '').toLowerCase();
    if (!ownerEmail || !email || email.toLowerCase() !== ownerEmail) {
      return Response.json(
        { error: 'AI Today settings are limited to the mailbox owner' },
        { status: 403 },
      );
    }
    if (request.method === 'GET') return getEnrichmentSettings(sql, userId);
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const errorResponse = bodyErrorResponse(error);
      if (errorResponse) return errorResponse;
      throw error;
    }
    return putEnrichmentSettings(sql, userId, body);
  }

  if (sub === 'image-upload') {
    if (request.method !== 'POST')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'POST' } },
      );
    return postImageUpload(request, { put, allowRequest, sql, userId }, env.BLOB_READ_WRITE_TOKEN);
  }

  if (sub === 'interests') {
    if (request.method === 'GET') return getInterests(sql, userId);
    if (request.method !== 'PUT')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, PUT' } },
      );
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const errorResponse = bodyErrorResponse(error);
      if (errorResponse) return errorResponse;
      throw error;
    }
    return putInterests(sql, userId, body);
  }

  if (sub === 'daily-note-seed') {
    if (request.method === 'GET') return getDailyNoteSeed(sql, userId);
    if (request.method !== 'PUT')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, PUT' } },
      );
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      const errorResponse = bodyErrorResponse(error);
      if (errorResponse) return errorResponse;
      throw error;
    }
    return putDailyNoteSeed(sql, userId, body);
  }

  // /tasks itself
  if (request.method === 'GET') return getTasks(sql, userId, url);
  if (request.method !== 'POST')
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET, POST' } },
    );
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    const errorResponse = bodyErrorResponse(error);
    if (errorResponse) return errorResponse;
    throw error;
  }
  return postTasks(sql, userId, body, env);
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').TasksEnv} env
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
      let email;
      try {
        ({ userId, email } = await verifyAccessToken(request, env, sql));
      } catch (error) {
        return withCors(
          authFailureResponse(error),
          origin,
          env.ALLOWED_ORIGIN,
          env.SENTRY_ENVIRONMENT,
        );
      }

      /** @type {Array<(sql: import('postgres').Sql) => Promise<unknown>>} */
      const indexing = [];
      const requestEnv = {
        ...env,
        deferSearchSync: (/** @type {(sql: import('postgres').Sql) => Promise<unknown>} */ job) =>
          indexing.push(job),
      };
      const response = await route(url, request, sql, userId, requestEnv, email);
      if (indexing.length) {
        ctx.waitUntil(
          (async () => {
            const backgroundSql = createSql(env.HYPERDRIVE.connectionString);
            try {
              for (const job of indexing) await job(backgroundSql);
            } finally {
              await backgroundSql.end({ timeout: 2 }).catch(() => undefined);
            }
          })().catch((error) => captureHandledException('search_sync', error, env)),
        );
      }
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

export default Sentry.withSentry(createSentryOptions, worker);
