import { createMcpHandler } from '@modelcontextprotocol/server';
import { withRequestMetrics } from '../../../shared/performance.js';
import * as Sentry from '@sentry/cloudflare';
import { createApi } from './api.js';
import { authenticate, METADATA_PATHS, protectedResourceMetadata } from './auth.js';
import { captureHandledException, createSentryOptions } from './sentry.js';
import { createServer } from './server.js';

/** @type {import('@modelcontextprotocol/server').McpHttpHandler | undefined} */
let handler;

/**
 * One handler per isolate. Its factory still builds a fresh server for every
 * request, around the caller and bindings that request's authInfo carries, so
 * nothing is shared between users; only the handler's own setup is reused.
 *
 * Default responseMode ('auto'): no tool emits progress or logging, so modern
 * responses are already a single JSON body. 'json' would say the same but
 * console.warn on construction.
 *
 */
function mcpHandler() {
  handler ??= createMcpHandler(
    ({ authInfo }) => {
      // fetch() below always supplies it; a server must never be built for
      // an unidentified caller.
      if (!authInfo?.extra) throw new Error('MCP request reached the server without a caller');
      const { caller, env } =
        /** @type {{caller: {userId: string, email: string, canWrite: boolean}, env: import('./sentry.js').McpEnv}} */ (
          authInfo.extra
        );
      return createServer(createApi(env, { userId: caller.userId, email: caller.email }), {
        canWrite: caller.canWrite,
        onUnexpected: (tool, error) => captureHandledException(tool, error, env),
        // Name, outcome and duration only: arguments and results never leave
        // the isolate.
        onToolCall: (call) => console.log(JSON.stringify({ event: 'mcp_tool', ...call })),
      });
    },
    {
      // The SDK answers its own failures and rejected requests itself; without
      // this they would leave no trace. The name only, since a rejection's
      // message can quote the request.
      onerror: (error) =>
        console.log(JSON.stringify({ event: 'mcp_handler_error', name: error?.name ?? 'Error' })),
    },
  );
  return handler;
}

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

    const caller = await authenticate(request, env, ctx);
    if (caller instanceof Response) return caller;

    try {
      // The bearer token stays here: authInfo carries the verified caller, not
      // the credential.
      return await mcpHandler().fetch(request, {
        authInfo: {
          token: '',
          clientId: '',
          scopes: [],
          extra: { caller, env },
        },
      });
    } catch (error) {
      captureHandledException('mcp', error, env);
      return Response.json({ error: 'Request failed' }, { status: 500 });
    }
  },
};

export default Sentry.withSentry(createSentryOptions, withRequestMetrics(worker, 'cookie-mcp'));
