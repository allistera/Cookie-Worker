import { describe, expect, test, vi } from 'vitest';
import { withHealthCheck } from './health.js';

describe('worker liveness', () => {
  test('responds without calling auth, database, or provider handlers', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Dependency unavailable');
    });
    const worker = withHealthCheck({ fetch });
    const response = await worker.fetch(new Request('https://worker.test/health'), {}, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(fetch).not.toHaveBeenCalled();
  });
  test('supports HEAD and rejects writes', async () => {
    const fetch = vi.fn();
    const worker = withHealthCheck({ fetch });
    const head = await worker.fetch(
      new Request('https://worker.test/health', { method: 'HEAD' }),
      {},
      {},
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const write = await worker.fetch(
      new Request('https://worker.test/health', { method: 'POST' }),
      {},
      {},
    );
    expect(write.status).toBe(405);
    expect(write.headers.get('Allow')).toBe('GET, HEAD');
    expect(fetch).not.toHaveBeenCalled();
  });
  test('preserves other routes, methods, and triggers', async () => {
    const response = new Response('protected', { status: 401 });
    const fetch = vi.fn(async () => response);
    const scheduled = vi.fn();
    const worker = withHealthCheck({ fetch, scheduled });
    const request = new Request('https://worker.test/health/other', { method: 'POST' });
    const env = { key: 'value' };
    const ctx = {};
    expect(await worker.fetch(request, env, ctx)).toBe(response);
    expect(fetch).toHaveBeenCalledWith(request, env, ctx);
    expect(worker.scheduled).toBe(scheduled);
  });
});
