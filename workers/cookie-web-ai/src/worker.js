import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import { withUserSql } from '../../../shared/db.js';
import { preflightResponse, withCors } from '../../../shared/cors.js';
import { allowRequest } from '../../../shared/rate-limit.js';
import { bodyErrorResponse, readJsonBody } from '../../../shared/read-body.js';
import { RATE_LIMIT } from './openai.js';
import { handleCompose } from './compose.js';
import { handleDocument } from './document.js';
import {
  DOCUMENT_CHAT_RATE_LIMIT,
  handleDocumentChat,
  MAX_CHAT_BODY_BYTES,
} from './documentChat.js';
import { handleRuleDraft } from './ruleDraft.js';
import { handleSummarize } from './summarize.js';
import { captureHandledException, createSentryOptions } from './sentry.js';

import { configureOpenAi } from '../../../shared/openai.js';

// Cookie-Web's api/compose.js and api/summarize.js were separate files only
// because of Vercel's function-per-file model — they share the same auth, the
// same OPENAI_API_KEY, and the same 'ai' rate-limit scope, so here they are
// two routes on one Worker. Per-route wording matches the originals exactly.
// Document chat sends far larger prompts (a whole draft plus history) to a
// bigger model, so it has its own, lower quota instead of the 'ai' scope.
const ROUTES = {
  'document-chat': {
    handler: handleDocumentChat,
    scope: 'document-chat',
    rateLimit: DOCUMENT_CHAT_RATE_LIMIT,
    notConfigured: 'Document AI chat is not configured',
    unavailable: 'Document AI chat is temporarily unavailable',
    tooMany: 'Too many document AI requests, slow down',
  },
  'rule-draft': {
    handler: handleRuleDraft,
    scope: 'ai',
    rateLimit: RATE_LIMIT,
    notConfigured: 'AI rule generation is not configured',
    unavailable: 'AI rule generation is temporarily unavailable',
    tooMany: 'Too many rule generation requests, slow down',
  },
  compose: {
    handler: handleCompose,
    scope: 'ai',
    rateLimit: RATE_LIMIT,
    notConfigured: 'AI compose is not configured',
    unavailable: 'AI compose is temporarily unavailable',
    tooMany: 'Too many compose requests, slow down',
  },
  summarize: {
    handler: handleSummarize,
    scope: 'ai',
    rateLimit: RATE_LIMIT,
    notConfigured: 'AI summarization is not configured',
    unavailable: 'AI summarization is temporarily unavailable',
    tooMany: 'Too many summary requests, slow down',
  },
  document: {
    handler: handleDocument,
    scope: 'ai',
    rateLimit: RATE_LIMIT,
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

  // The body is read, and each handler validates it, before any quota is
  // claimed, so a malformed (400) or oversized (413) request does not burn a
  // request from the user's AI allowance. Handlers call claimQuota once
  // their input is known to be usable, right before the OpenAI call.
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

  /** @returns {Promise<Response | null>} */
  const claimQuota = async () => {
    let allowed;
    try {
      allowed = await allowRequest(sql, userId, config.scope, config.rateLimit);
    } catch (err) {
      console.error(
        `POST ${url.pathname} quota enforcement failed:`,
        /** @type {Error} */ (err).message,
      );
      return Response.json({ error: config.unavailable }, { status: 503 });
    }
    return allowed ? null : Response.json({ error: config.tooMany }, { status: 429 });
  };
  return config.handler(sql, userId, body, /** @type {any} */ (env), claimQuota);
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
    try {
      // Every AI route is a POST that spends quota and OpenAI tokens, so in
      // practice nothing here is retried; only reads would be.
      const response = await withUserSql(
        request,
        env,
        ctx,
        { retryable: request.method === 'GET' || request.method === 'HEAD' },
        (sql, userId) => route(url, request, sql, userId, env),
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

export default Sentry.withSentry(createSentryOptions, withRequestMetrics(worker, 'cookie-web-ai'));
