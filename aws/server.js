// One Node HTTP server for the Workers that run on AWS. Cookie-Infra's Lambda Web Function
// `cookie-web` starts it, and CloudFront sends every API hostname there, naming the hostname in
// x-forwarded-host (Cookie-Infra docs/deploy-contract.md). Each request reaches its Worker's own
// fetch handler as a Fetch API Request, with an env and an execution context shaped like
// Cloudflare's, so the Worker code runs unchanged.

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * @typedef {{waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void, props: Record<string, unknown>}} Context
 * @typedef {{fetch(request: Request, env: any, ctx: Context): Response | Promise<Response>}} FetchWorker
 * @typedef {{hostname: string, worker: FetchWorker, env: Record<string, unknown>}} Route
 */

const JSON_HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

/**
 * A Worker's env on AWS: its wrangler.jsonc vars, the secrets it names, read from the revision's
 * environment, and a stand-in for the Hyperdrive binding built from DATABASE_URL.
 *
 * @param {Record<string, unknown>} vars
 * @param {string[]} secretNames
 * @param {Record<string, string | undefined>} processEnv
 */
export function workerEnv(vars, secretNames, processEnv) {
  /** @type {Record<string, unknown>} */
  const env = { ...vars };
  for (const name of secretNames) {
    if (processEnv[name] !== undefined) env[name] = processEnv[name];
  }
  if (processEnv.DATABASE_URL) {
    env.HYPERDRIVE = { connectionString: requireTls(processEnv.DATABASE_URL) };
  }
  return env;
}

/**
 * Hyperdrive terminated TLS for the Workers, so shared/db.js asks the driver for none. Here the
 * driver reaches Supabase directly, and sslmode in the URL turns TLS on without touching db.js.
 *
 * @param {string} databaseUrl
 */
export function requireTls(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    // The URL parser's own error carries the input, password included.
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!url.searchParams.has('sslmode')) url.searchParams.set('sslmode', 'require');
  return url.toString();
}

/**
 * The request handler and the background work it is still waiting on.
 *
 * @param {Route[]} routes
 * @param {{version: string}} options `version` is the commit, reported by the server's /health.
 */
export function createHandler(routes, { version }) {
  const byHostname = new Map(routes.map((route) => [route.hostname, route]));
  /** @type {Set<Promise<void>>} */
  const pending = new Set();

  /** @returns {Context} */
  function executionContext() {
    return {
      // The process is not frozen after a response, so the work simply keeps running; the set
      // lets shutdown wait for it.
      waitUntil(promise) {
        const tracked = Promise.resolve(promise)
          .then(
            () => undefined,
            (error) => {
              console.log(
                JSON.stringify({ event: 'background_task_failed', error: errorName(error) }),
              );
            },
          )
          .finally(() => pending.delete(tracked));
        pending.add(tracked);
      },
      passThroughOnException() {},
      props: {},
    };
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const hostname = forwardedHost(req);
    const route = byHostname.get(hostname);
    /** @type {Response} */
    let response;
    try {
      response = route
        ? await route.worker.fetch(toRequest(req, hostname), route.env, executionContext())
        : ownResponse(req, version);
    } catch (error) {
      // Never the URL: pixel and OAuth query strings carry tokens.
      console.log(
        JSON.stringify({
          event: 'request_failed',
          host: hostname,
          method: req.method,
          error: errorName(error),
        }),
      );
      response = Response.json({ error: 'Request failed' }, { status: 500, headers: JSON_HEADERS });
    }
    await send(res, response, req.method);
  }

  return { handle, pending };
}

/** @param {import('node:http').IncomingMessage} req */
function forwardedHost(req) {
  const header = req.headers['x-forwarded-host'];
  const value = Array.isArray(header) ? header[0] : header;
  return (value ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/u, '');
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} hostname
 */
function toRequest(req, hostname) {
  const headers = new Headers();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    headers.append(req.rawHeaders[index], req.rawHeaders[index + 1]);
  }
  const method = req.method ?? 'GET';
  /** @type {RequestInit & {duplex?: 'half'}} */
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = /** @type {ReadableStream} */ (/** @type {unknown} */ (Readable.toWeb(req)));
    init.duplex = 'half';
  }
  return new Request(`https://${hostname}${req.url ?? '/'}`, init);
}

/**
 * The server's own routes, for any hostname no Worker claims: CloudFront's own domain, which the
 * deploy smoke test calls, or the endpoint domain.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} version
 */
function ownResponse(req, version) {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname !== '/health') {
    return Response.json({ error: 'Not Found' }, { status: 404, headers: JSON_HEADERS });
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return Response.json({ status: 'ok', version }, { headers: JSON_HEADERS });
  }
  return Response.json(
    { error: 'Method not allowed' },
    { status: 405, headers: { ...JSON_HEADERS, Allow: 'GET, HEAD' } },
  );
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {Response} response
 * @param {string | undefined} method
 */
async function send(res, response, method) {
  /** @type {Record<string, string | string[]>} */
  const headers = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body || method === 'HEAD') {
    res.end();
    await response.body?.cancel();
    return;
  }
  try {
    await pipeline(Readable.fromWeb(/** @type {any} */ (response.body)), res);
  } catch {
    // The client went away or the body stream failed; nobody is left to tell.
    res.destroy();
  }
}

/** @param {unknown} error */
function errorName(error) {
  return error instanceof Error ? error.name : 'Error';
}

/**
 * Wait for background work, but never past the deadline: after SIGTERM, Lambda kills the process
 * one second later.
 *
 * @param {Set<Promise<void>>} pending
 * @param {number} timeoutMs
 */
export async function drain(pending, timeoutMs) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.allSettled([...pending]), deadline]);
  clearTimeout(timer);
}

/**
 * Listen where Lambda says, AWS_LAMBDA_HTTP_ENDPOINT as host:port, or on localhost:3000 for a
 * local run.
 *
 * @param {Route[]} routes
 * @param {{version: string}} options
 */
export function serve(routes, options) {
  const { handle, pending } = createHandler(routes, options);
  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT || 'localhost:3000';
  const separator = endpoint.lastIndexOf(':');
  const host = endpoint.slice(0, separator).replace(/^\[|\]$/gu, '');
  server.listen(Number(endpoint.slice(separator + 1)), host);
  process.once('SIGTERM', () => {
    server.close();
    drain(pending, 800).finally(() => process.exit(0));
  });
  return server;
}
