import { createMcpHandler } from '@modelcontextprotocol/server';
import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import { createApi } from './api.js';
import { authenticate, METADATA_PATHS, protectedResourceMetadata } from './auth.js';
import { captureHandledException, createSentryOptions } from './sentry.js';
import { createServer } from './server.js';

const worker = {
  /**
   * @param {Request} request
   * @param {import('./sentry.js').McpEnv} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (METADATA_PATHS.includes(url.pathname)) {
      return Response.json(protectedResourceMetadata(env), {
        headers: { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (url.pathname !== '/mcp') return Response.json({ error: 'Not Found' }, { status: 404 });

    const identity = await authenticate(request, env, ctx);
    if (identity instanceof Response) return identity;

    const api = createApi(env, identity);
    // Default responseMode ('auto'): no tool emits progress or logging, so
    // modern responses are already a single JSON body. 'json' would say the
    // same but console.warn on every construction, i.e. every request here.
    const handler = createMcpHandler(() =>
      createServer(api, {
        onUnexpected: (tool, error) => captureHandledException(tool, error, env),
      }),
    );
    try {
      return await handler.fetch(request);
    } catch (error) {
      captureHandledException('mcp', error, env);
      return Response.json({ error: 'Request failed' }, { status: 500 });
    }
  },
};

export default Sentry.withSentry(createSentryOptions, withRequestMetrics(worker, 'cookie-mcp'));
