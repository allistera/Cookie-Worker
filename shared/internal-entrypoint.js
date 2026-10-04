// The `Internal` named entrypoint every MCP-reachable API Worker exports.
// Named entrypoints are reachable only through a service binding, never from
// the internet, so the identity argument comes from a Worker that already
// verified its caller (cookie-mcp). The request runs through the Worker's
// ordinary, fully wrapped fetch handler, so routing, validation, rate limits
// and Sentry reporting are exactly the SPA's.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { runAsInternalCaller } from './internal-identity.js';

const INTERNAL_ORIGIN = 'https://internal.cookie';
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * @param {{fetch: (request: Request, env: any, ctx: ExecutionContext) => Promise<Response>}} worker
 */
export function createInternalEntrypoint(worker) {
  return class Internal extends WorkerEntrypoint {
    /**
     * @param {import('./internal-identity.js').InternalIdentity} identity
     * @param {{method: string, path: string, body?: unknown}} call
     * @returns {Promise<{status: number, body: unknown}>}
     */
    async call(identity, { method, path, body }) {
      if (!METHODS.has(method)) throw new TypeError(`Unsupported method ${method}`);
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
        throw new TypeError('path must be an absolute API path');
      }
      const request = new Request(new URL(path, INTERNAL_ORIGIN), {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const response = await runAsInternalCaller(identity, () =>
        worker.fetch(request, this.env, this.ctx),
      );
      const text = await response.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      return { status: response.status, body: parsed };
    }
  };
}
