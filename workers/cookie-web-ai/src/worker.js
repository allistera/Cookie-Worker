import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import postgres from 'postgres';
import { authFailureResponse, verifyAccessToken } from '../../../shared/auth-jwt.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { allowRequest } from '../../../shared/rate-limit.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { RATE_LIMIT } from './openai.js';
import { handleCompose } from './compose.js';
import { handleDocument } from './document.js';
import { handleDocumentChat, MAX_CHAT_BODY_BYTES } from './documentChat.js';
import { handleRuleDraft } from './ruleDraft.js';
import { handleSummarize } from './summarize.js';
import { captureHandledException, createSentryOptions } from './sentry.js';

import { configureOpenAi } from '../../../shared/openai.js';
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

// Cookie-Web's api/compose.js and api/summarize.js were separate files only
// because of Vercel's function-per-file model — they share the same auth, the
// same OPENAI_API_KEY, and the same 'ai' rate-limit scope, so here they are
// two routes on one Worker. Per-route wording matches the originals exactly.
const ROUTES = {
  'document-chat': {
    handler: handleDocumentChat,
    notConfigured: 'Document AI chat is not configured',
    unavailable: 'Document AI chat is temporarily unavailable',
    tooMany: 'Too many document AI requests, slow down',
  },
  'rule-draft': {
    handler: handleRuleDraft,
    notConfigured: 'AI rule generation is not configured',
    unavailable: 'AI rule generation is temporarily unavailable',
    tooMany: 'Too many rule generation requests, slow down',
  },
  compose: {
    handler: handleCompose,
    notConfigured: 'AI compose is not configured',
    unavailable: 'AI compose is temporarily unavailable',
    tooMany: 'Too many compose requests, slow down',
  },
  summarize: {
    handler: handleSummarize,
    notConfigured: 'AI summarization is not configured',
    unavailable: 'AI summarization is temporarily unavailable',
    tooMany: 'Too many summary requests, slow down',
  },
  document: {
    handler: handleDocument,
    notConfigured: 'AI documents are not configured',
    unavailable: 'AI documents are temporarily unavailable',
    tooMany: 'Too many document requests, slow down',
  },
};

/**
 * @param {URL} url
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {import('./sentry.js').AiEnv} env
 */
async function route(url, request, sql, userId, env) {
  const segments = url.pathname.split('/').filter(Boolean);
  const config =
    segments.length === 1 ? ROUTES[/** @type {keyof typeof ROUTES} */ (segments[0])] : undefined;
  if (!config) {
    return Response.json({ error: 'Not Found' }, { status: 404 });
  }
  if (request.method !== 'POST') {
    return Response.json(
      { error: 'Method not allowed' },
      { status: 405, headers: { Allow: 'POST' } },
    );
  }

  if (!env.OPENAI_API_KEY) {
    return Response.json({ error: config.notConfigured }, { status: 503 });
  }
  let allowed;
  try {
    allowed = await allowRequest(sql, userId, 'ai', RATE_LIMIT);
  } catch (err) {
    console.error(
      `POST ${url.pathname} quota enforcement failed:`,
      /** @type {Error} */ (err).message,
    );
    return Response.json({ error: config.unavailable }, { status: 503 });
  }
  if (!allowed) {
    return Response.json({ error: config.tooMany }, { status: 429 });
  }

  let body;
  try {
    body = await readJsonBody(
      request,
      url.pathname === '/document-chat' ? { maxBytes: MAX_CHAT_BODY_BYTES } : {},
    );
  } catch (error) {
    const errorResponse = bodyErrorResponse(/** @type {Error} */ (error));
    if (errorResponse) return errorResponse;
    throw error;
  }
  return config.handler(sql, userId, body, /** @type {any} */ (env));
}

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').AiEnv} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    configureOpenAi(env);
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

export default Sentry.withSentry(createSentryOptions, withRequestMetrics(worker, 'cookie-web-ai'));
