import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import { issueSignedToken, presignUrl, put } from '@vercel/blob';
import { createSql, withUserSql } from '../../../shared/db.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { hybridSearch } from '../../../shared/meili.js';
import { validId } from '../../../shared/pagination.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { getDailyNoteSeed, putDailyNoteSeed } from './dailyNoteSeed.js';
import { createDocument, deleteDocument, getDocuments, updateDocument } from './documents.js';
import { getEnrichmentSettings, putEnrichmentSettings } from './enrichmentSettings.js';
import { deleteFile, getFile, getFileContent, listFiles, updateFile, uploadFile } from './files.js';
import { getDocumentImageUrl, postImageUpload } from './imageUpload.js';
import { getInterests, putInterests } from './interests.js';
import { createProject, deleteProject, getProjects, updateProject } from './projects.js';
import { createTaskLabel, deleteTaskLabel, getTaskLabels, updateTaskLabel } from './taskLabels.js';
import { allowRequest } from '../../../shared/rate-limit.js';
import { postRefresh } from './refresh.js';
import { captureHandledException, createSentryOptions } from './sentry.js';
import {
  createTaskItem,
  deleteTaskItem,
  getTaskItems,
  reorderTaskItems,
  updateTaskItem,
} from './taskItems.js';
import { createAiTask, interpretTask } from './taskAi.js';
import { getTasks, postTasks } from './tasks.js';

import { configureOpenAi } from '../../../shared/openai.js';
// Vercel's body cap is 4.5 MB; keep that for document payloads, but use a much
// smaller default for the ordinary command endpoints this Worker serves.
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

/**
 * Reads the JSON body and hands it to `handle`. A body that is too large, not
 * JSON, or otherwise refused by readJsonBody becomes its 4xx response; any
 * other failure propagates to the 500 handler.
 *
 * @param {Request} request
 * @param {(body: any) => Promise<Response> | Response} handle
 * @param {{maxBytes?: number}} [options]
 */
async function withJsonBody(request, handle, options) {
  let body;
  try {
    body = await readJsonBody(request, options);
  } catch (error) {
    const errorResponse = bodyErrorResponse(error);
    if (errorResponse) return errorResponse;
    throw error;
  }
  return handle(body);
}

/**
 * Whether the caller is the OWNER_EMAIL mailbox. withUserSql resolves only the
 * caller's id, so the two owner-only routes look the email up themselves; with
 * no OWNER_EMAIL configured nobody is the owner and nothing is read.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {import('./sentry.js').TasksEnv} env
 */
async function isMailboxOwner(sql, userId, env) {
  const ownerEmail = String(env.OWNER_EMAIL ?? '').toLowerCase();
  if (!ownerEmail) return false;
  const [user] = await sql`SELECT lower(email) AS email FROM users WHERE id = ${userId}`;
  return user?.email === ownerEmail;
}

/**
 * Routes GET/POST /tasks, POST /tasks/refresh, GET/PUT /tasks/interests,
 * GET/PUT /tasks/enrichment-settings,
 * POST /task-items/reorder, POST /task-items/interpret,
 * GET/POST/PATCH/DELETE /task-labels,
 * GET/PUT /tasks/daily-note-seed, POST /tasks/image-upload, GET /tasks/document-image, and
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
 */
async function route(url, request, sql, userId, env) {
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] === 'task-items') {
    const reorder = segments.length === 2 && segments[1] === 'reorder';
    const generate = segments.length === 2 && segments[1] === 'generate';
    const interpret = segments.length === 2 && segments[1] === 'interpret';
    if (segments.length > 1 && !reorder && !interpret && !generate) {
      return Response.json({ error: 'Not Found' }, { status: 404 });
    }
    if ((reorder || interpret || generate) && request.method !== 'POST') {
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
    return withJsonBody(request, (body) => {
      if (generate) return createAiTask(sql, userId, body, env);
      if (interpret) return interpretTask(sql, userId, body, env);
      if (reorder) return reorderTaskItems(sql, userId, body);
      if (request.method === 'POST') return createTaskItem(sql, userId, body, env);
      if (request.method === 'PATCH') return updateTaskItem(sql, userId, body, env);
      return deleteTaskItem(sql, userId, body, env);
    });
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
    return withJsonBody(request, (body) => {
      if (request.method === 'POST') return createProject(sql, userId, body);
      if (request.method === 'PATCH') return updateProject(sql, userId, body);
      return deleteProject(sql, userId, body);
    });
  }

  if (segments[0] === 'task-labels') {
    if (segments.length > 1) return Response.json({ error: 'Not Found' }, { status: 404 });
    if (request.method === 'GET') return getTaskLabels(sql, userId);
    if (request.method !== 'POST' && request.method !== 'PATCH' && request.method !== 'DELETE') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, POST, PATCH, DELETE' } },
      );
    }
    return withJsonBody(request, (body) => {
      if (request.method === 'POST') return createTaskLabel(sql, userId, body);
      if (request.method === 'PATCH') return updateTaskLabel(sql, userId, body);
      return deleteTaskLabel(sql, userId, body);
    });
  }

  if (segments[0] === 'files') {
    if (segments.length === 1) {
      if (request.method === 'GET') return listFiles(sql, userId, url);
      if (request.method === 'POST') return uploadFile(request, sql, userId, env, { allowRequest });
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, POST' } },
      );
    }
    const id = segments[1];
    if (!validId(id) || segments.length > 3) {
      return Response.json({ error: 'Not Found' }, { status: 404 });
    }
    if (segments.length === 3) {
      if (segments[2] !== 'content') return Response.json({ error: 'Not Found' }, { status: 404 });
      if (request.method !== 'GET')
        return Response.json(
          { error: 'Method not allowed' },
          { status: 405, headers: { Allow: 'GET' } },
        );
      return getFileContent(sql, userId, id, env);
    }
    if (request.method === 'GET') return getFile(sql, userId, id);
    if (request.method === 'DELETE') {
      return deleteFile(sql, userId, id, env, {
        report: (operation, error, extra) => captureHandledException(operation, error, env, extra),
      });
    }
    if (request.method !== 'PATCH')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, PATCH, DELETE' } },
      );
    return withJsonBody(request, (body) => updateFile(sql, userId, id, body));
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
    return withJsonBody(
      request,
      (body) => {
        if (request.method === 'POST') return createDocument(sql, userId, body, deps, env);
        if (request.method === 'PATCH') return updateDocument(sql, userId, body, deps, env);
        return deleteDocument(sql, userId, body, env);
      },
      { maxBytes: MAX_BODY_BYTES },
    );
  }

  if (segments[0] !== 'tasks' || segments.length > 2) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
  const sub = segments[1];
  if (
    sub &&
    ![
      'refresh',
      'interests',
      'enrichment-settings',
      'daily-note-seed',
      'image-upload',
      'document-image',
    ].includes(sub)
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
    if (!(await isMailboxOwner(sql, userId, env))) {
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
    if (!(await isMailboxOwner(sql, userId, env))) {
      return Response.json(
        { error: 'AI Today settings are limited to the mailbox owner' },
        { status: 403 },
      );
    }
    if (request.method === 'GET') return getEnrichmentSettings(sql, userId);
    return withJsonBody(request, (body) => putEnrichmentSettings(sql, userId, body));
  }

  if (sub === 'image-upload') {
    if (request.method !== 'POST')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'POST' } },
      );
    return postImageUpload(
      request,
      {
        put,
        allowRequest,
        sql,
        userId,
        report: (operation, error) => captureHandledException(operation, error, env),
      },
      env.BLOB_READ_WRITE_TOKEN,
    );
  }

  if (sub === 'document-image') {
    if (request.method !== 'GET')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET' } },
      );
    return getDocumentImageUrl(url, userId, {
      issueSignedToken,
      presignUrl,
      token: env.BLOB_READ_WRITE_TOKEN,
    });
  }

  if (sub === 'interests') {
    if (request.method === 'GET') return getInterests(sql, userId);
    if (request.method !== 'PUT')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, PUT' } },
      );
    return withJsonBody(request, (body) => putInterests(sql, userId, body));
  }

  if (sub === 'daily-note-seed') {
    if (request.method === 'GET') return getDailyNoteSeed(sql, userId);
    if (request.method !== 'PUT')
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: { Allow: 'GET, PUT' } },
      );
    return withJsonBody(request, (body) => putDailyNoteSeed(sql, userId, body));
  }

  // /tasks itself
  if (request.method === 'GET') return getTasks(sql, userId, url);
  if (request.method !== 'POST')
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'GET, POST' } },
    );
  return withJsonBody(request, (body) => postTasks(sql, userId, body, env));
}

/**
 * A request's deferred search jobs. Keyed, so a request that touches one task
 * or document several times (a task created with sub-tasks, say) queues one
 * job for it. The jobs read state committed before they start, so they run
 * together and their task polling overlaps instead of stacking; syncedRoots lets sibling sub-task
 * jobs share their root's push. Rejects with the first failure once all have
 * settled.
 */
export function createSearchSyncQueue() {
  /** @type {Map<unknown, (sql: import('postgres').Sql) => Promise<unknown>>} */
  const jobs = new Map();
  return {
    /** @type {Set<string>} */
    syncedRoots: new Set(),
    /**
     * @param {(sql: import('postgres').Sql) => Promise<unknown>} job
     * @param {string} [key]
     */
    defer(job, key) {
      const slot = key ?? Symbol('search-sync');
      if (!jobs.has(slot)) jobs.set(slot, job);
    },
    size: () => jobs.size,
    /** @param {import('postgres').Sql} sql */
    async run(sql) {
      const results = await Promise.allSettled([...jobs.values()].map((job) => job(sql)));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw /** @type {PromiseRejectedResult} */ (failure).reason;
    },
  };
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').TasksEnv} env
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
      // Reads are idempotent, so a dropped Hyperdrive connection gets one more
      // go on a fresh client (caller lookup included). Writes are not retried.
      const response = await withUserSql(
        request,
        env,
        ctx,
        { retryable: request.method === 'GET' || request.method === 'HEAD' },
        async (sql, userId) => {
          // Per attempt: a retried read starts with an empty queue rather than
          // replaying jobs a dropped attempt had queued.
          const indexing = createSearchSyncQueue();
          const requestEnv = {
            ...env,
            searchSyncedRoots: indexing.syncedRoots,
            deferSearchSync: indexing.defer,
          };
          const routed = await route(url, request, sql, userId, requestEnv);
          if (indexing.size()) {
            ctx.waitUntil(
              (async () => {
                const backgroundSql = createSql(env.HYPERDRIVE.connectionString);
                try {
                  await indexing.run(backgroundSql);
                } finally {
                  await backgroundSql.end({ timeout: 2 }).catch(() => undefined);
                }
              })().catch((error) => captureHandledException('search_sync', error, env)),
            );
          }
          return routed;
        },
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
  withRequestMetrics(worker, 'cookie-web-tasks'),
);
