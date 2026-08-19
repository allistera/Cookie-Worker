import { describe, expect, test } from 'vitest';
import worker from '../src/worker.js';

const TOKEN = 'test-trigger-token';
const env = /** @type {any} */ ({ HTTP_TRIGGER_TOKEN: TOKEN });
// The default export is Sentry-wrapped and flushes through ctx.waitUntil.
const ctx = /** @type {any} */ ({ waitUntil: () => undefined });

/**
 * @param {string} path
 * @param {{method?: string, token?: string}} [options]
 */
function request(path, { method = 'POST', token } = {}) {
  return new Request(`https://scheduled-send-flusher.example.workers.dev${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe('HTTP trigger', () => {
  test('rejects unknown paths', async () => {
    const response = await worker.fetch(request('/other', { token: TOKEN }), env, ctx);
    expect(response.status).toBe(404);
  });

  test('rejects non-POST methods', async () => {
    const response = await worker.fetch(request('/run', { method: 'GET', token: TOKEN }), env, ctx);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  test('rejects a missing bearer token', async () => {
    const response = await worker.fetch(request('/run'), env, ctx);
    expect(response.status).toBe(401);
  });

  test('rejects a wrong bearer token', async () => {
    const response = await worker.fetch(request('/run', { token: 'wrong' }), env, ctx);
    expect(response.status).toBe(401);
  });

  test('stays closed when no token is configured', async () => {
    const response = await worker.fetch(
      request('/run', { token: 'undefined' }),
      /** @type {any} */ ({}),
      ctx,
    );
    expect(response.status).toBe(401);
  });
});
