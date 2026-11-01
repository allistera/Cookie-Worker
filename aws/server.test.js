import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHandler, drain, requireTls, workerEnv } from './server.js';

/** @type {import('node:http').Server[]} */
const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/**
 * @param {import('./server.js').Route[]} routes
 * @param {string} [version]
 */
async function listen(routes, version = 'test-version') {
  const { handle, pending } = createHandler(routes, { version });
  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { base: `http://127.0.0.1:${port}`, pending };
}

describe('worker env', () => {
  test('holds the wrangler vars, the named secrets and a Hyperdrive stand-in that requires TLS', () => {
    const env = workerEnv({ ALLOWED_ORIGIN: 'https://mail.example' }, ['SENTRY_DSN', 'ABSENT'], {
      SENTRY_DSN: 'dsn',
      OTHER_SECRET: 'not named by this Worker',
      DATABASE_URL: 'postgres://user:pa%40ss@db.example:5432/postgres',
    });
    expect(env).toEqual({
      ALLOWED_ORIGIN: 'https://mail.example',
      SENTRY_DSN: 'dsn',
      HYPERDRIVE: {
        connectionString: 'postgres://user:pa%40ss@db.example:5432/postgres?sslmode=require',
      },
    });
  });

  test('keeps an sslmode the URL already chose and leaves Hyperdrive out without a URL', () => {
    expect(requireTls('postgres://user:pass@db.example/postgres?sslmode=verify-full')).toBe(
      'postgres://user:pass@db.example/postgres?sslmode=verify-full',
    );
    expect(workerEnv({}, [], {})).toEqual({});
  });

  test('rejects an invalid DATABASE_URL without quoting it', () => {
    expect(() => requireTls('not a url, password hunter2')).toThrow(
      new Error('DATABASE_URL is not a valid URL'),
    );
  });
});

describe('request handling', () => {
  test('gives the Worker for x-forwarded-host the public URL, the headers and the body', async () => {
    const workerFetch = vi.fn(async (/** @type {Request} */ request, env) =>
      Response.json({
        url: request.url,
        method: request.method,
        ip: request.headers.get('cf-connecting-ip'),
        body: await request.text(),
        env,
      }),
    );
    const { base } = await listen([
      {
        hostname: 'receipts-api.example',
        worker: { fetch: workerFetch },
        env: { NAME: 'receipts' },
      },
    ]);

    const response = await fetch(`${base}/read-receipts?messageIds=a`, {
      method: 'POST',
      headers: { 'x-forwarded-host': 'Receipts-API.example', 'cf-connecting-ip': '198.51.100.7' },
      body: 'hello',
    });

    expect(await response.json()).toEqual({
      url: 'https://receipts-api.example/read-receipts?messageIds=a',
      method: 'POST',
      ip: '198.51.100.7',
      body: 'hello',
      env: { NAME: 'receipts' },
    });
  });

  test('answers /health itself, with its version, for a hostname no Worker claims', async () => {
    const { base } = await listen([], 'abc123');

    const health = await fetch(`${base}/health`, {
      headers: { 'x-forwarded-host': 'd111.cloudfront.net' },
    });
    expect(health.status).toBe(200);
    expect(health.headers.get('cache-control')).toBe('no-store');
    expect(await health.json()).toEqual({ status: 'ok', version: 'abc123' });

    expect((await fetch(`${base}/read-receipts`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
  });

  test('passes status and every Set-Cookie through, and no body for HEAD', async () => {
    const worker = {
      fetch: async () => {
        const headers = new Headers();
        headers.append('set-cookie', 'a=1');
        headers.append('set-cookie', 'b=2');
        return new Response('created', { status: 201, headers });
      },
    };
    const { base } = await listen([{ hostname: 'api.example', worker, env: {} }]);
    const headers = { 'x-forwarded-host': 'api.example' };

    const response = await fetch(base, { headers });
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await response.text()).toBe('created');

    const head = await fetch(base, { method: 'HEAD', headers });
    expect(head.status).toBe(201);
    expect(await head.text()).toBe('');
  });

  test('responds before waitUntil work finishes and tracks that work until it settles', async () => {
    /** @type {(value?: unknown) => void} */
    let finish = () => {};
    const background = new Promise((resolve) => {
      finish = resolve;
    });
    const worker = {
      fetch: async (/** @type {Request} */ _request, _env, /** @type {any} */ ctx) => {
        ctx.waitUntil(background);
        return new Response('sent');
      },
    };
    const { base, pending } = await listen([{ hostname: 'api.example', worker, env: {} }]);

    const response = await fetch(base, { headers: { 'x-forwarded-host': 'api.example' } });
    expect(await response.text()).toBe('sent');
    expect(pending.size).toBe(1);

    finish();
    await drain(pending, 1_000);
    expect(pending.size).toBe(0);
  });

  test('turns a Worker failure into a 500 and logs neither the URL nor the error text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const worker = {
      fetch: async () => {
        throw new Error('connect failed for postgres://user:hunter2@db.example/postgres');
      },
    };
    const { base } = await listen([{ hostname: 'api.example', worker, env: {} }]);

    const response = await fetch(`${base}/read-receipts?token=opaque-token`, {
      headers: { 'x-forwarded-host': 'api.example' },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Request failed' });
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toContain('request_failed');
    expect(logged).not.toMatch(/hunter2|opaque-token/u);
  });
});

describe('shutdown', () => {
  test('stops waiting for background work at the deadline', async () => {
    const started = Date.now();
    await drain(new Set([new Promise(() => {})]), 50);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
