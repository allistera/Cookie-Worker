import * as Sentry from '@sentry/cloudflare';
import { put } from '@vercel/blob';
import postgres from 'postgres';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { getDailyNoteSeed, putDailyNoteSeed } from './dailyNoteSeed.js';
import { createDocument, deleteDocument, getDocuments, updateDocument } from './documents.js';
import { embedText, embedTextCached } from './embeddings.js';
import { postImageUpload } from './imageUpload.js';
import { getInterests, putInterests } from './interests.js';
import { createProject, deleteProject, getProjects, updateProject } from './projects.js';
import { allowRequest } from './rateLimit.js';
import { postRefresh } from './refresh.js';
import { captureHandledException, createSentryOptions } from './sentry.js';
import { getTasks, postTasks } from './tasks.js';

// Matches Cookie-Web's own api/_lib/body.js limit (Vercel's ~4.5 MB request
// body cap), so a request that would be rejected there behaves the same way
// here. Image uploads go through formData() instead and are bounded by
// imageUpload.js's own MAX_IMAGE_BYTES.
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
 * Routes GET/POST /tasks, POST /tasks/refresh, GET/PUT /tasks/interests,
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

  if (segments[0] === 'projects') {
    if (segments.length > 1) return Response.json({ error: 'Not Found' }, { status: 404 });
    if (request.method === 'GET') return getProjects(sql, userId);
    if (request.method !== 'POST' && request.method !== 'PATCH' && request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (request.method === 'POST') return createProject(sql, userId, body);
    if (request.method === 'PATCH') return updateProject(sql, userId, body);
    return deleteProject(sql, userId, body);
  }

  if (segments[0] === 'documents') {
    if (segments.length > 1) return Response.json({ error: 'Not Found' }, { status: 404 });
    const deps = {
      openaiApiKey: env.OPENAI_API_KEY,
      allowRequest,
      embedText,
      embedTextCached,
    };
    if (request.method === 'GET') return getDocuments(sql, userId, url, deps);
    if (request.method !== 'POST' && request.method !== 'PATCH' && request.method !== 'DELETE') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (request.method === 'POST') return createDocument(sql, userId, body, deps);
    if (request.method === 'PATCH') return updateDocument(sql, userId, body, deps);
    return deleteDocument(sql, userId, body);
  }

  if (segments[0] !== 'tasks' || segments.length > 2) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
  const sub = segments[1];
  if (sub && !['refresh', 'interests', 'daily-note-seed', 'image-upload'].includes(sub)) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }

  if (sub === 'refresh') {
    if (request.method !== 'POST')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    // The enricher rebuilds state for the fixed OWNER_EMAIL mailbox, so only
    // that owner may trigger it — any other provisioned account would be
    // spending the owner's AI budget and racing the owner's generated state.
    const ownerEmail = String(env.OWNER_EMAIL ?? '').toLowerCase();
    if (!ownerEmail || !email || email.toLowerCase() !== ownerEmail) {
      return Response.json({ error: 'Refresh is limited to the mailbox owner' }, { status: 403 });
    }
    return postRefresh(sql, userId, env.ENRICHER, env.ENRICHER_TRIGGER_TOKEN);
  }

  if (sub === 'image-upload') {
    if (request.method !== 'POST')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    return postImageUpload(request, { put, allowRequest, sql, userId }, env.BLOB_READ_WRITE_TOKEN);
  }

  if (sub === 'interests') {
    if (request.method === 'GET') return getInterests(sql, userId);
    if (request.method !== 'PUT')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    return putInterests(sql, userId, body);
  }

  if (sub === 'daily-note-seed') {
    if (request.method === 'GET') return getDailyNoteSeed(sql, userId);
    if (request.method !== 'PUT')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    let body;
    try {
      body = await readJsonBody(request);
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    return putDailyNoteSeed(sql, userId, body);
  }

  // /tasks itself
  if (request.method === 'GET') return getTasks(sql, userId);
  if (request.method !== 'POST')
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  return postTasks(sql, userId, body, env.TODOIST_API_TOKEN);
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').TasksEnv} env
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

      const response = await route(url, request, sql, userId, env, email);
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
