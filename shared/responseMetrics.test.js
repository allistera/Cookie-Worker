import { afterEach, describe, expect, it, vi } from 'vitest';
import { withResponseMetrics } from './responseMetrics.js';

const request = new Request('https://worker.example/messages');
const ctx = /** @type {any} */ ({ waitUntil: () => undefined });

afterEach(() => vi.useRealTimers());

describe('withResponseMetrics', () => {
  it('writes one data point per response with the service, method, route, duration and status', async () => {
    vi.useFakeTimers();
    const writeDataPoint = vi.fn();
    const worker = {
      async fetch() {
        vi.advanceTimersByTime(42);
        return new Response('created', { status: 201 });
      },
    };
    const env = /** @type {any} */ ({ RESPONSE_METRICS: { writeDataPoint } });

    const response = await withResponseMetrics(worker, 'cookie-web-messages').fetch(
      request,
      env,
      ctx,
    );

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('created');
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['cookie-web-messages'],
      blobs: ['cookie-web-messages', 'GET', '/messages'],
      doubles: [42, 201],
    });
  });

  it('records the route template, never an identifier or the query string', async () => {
    const writeDataPoint = vi.fn();
    const worker = { fetch: async () => new Response(null, { status: 204 }) };
    const env = /** @type {any} */ ({ RESPONSE_METRICS: { writeDataPoint } });
    const wrapped = withResponseMetrics(worker, 'svc');

    await wrapped.fetch(
      new Request(
        'https://worker.example/messages/7f3a9c1e-2b4d-4e6f-8a1b-3c5d7e9f0a1b/labels?token=secret',
        { method: 'PATCH' },
      ),
      env,
      ctx,
    );
    await wrapped.fetch(new Request('https://worker.example/health'), env, ctx);
    await wrapped.fetch(
      new Request('https://worker.example/messages', { method: 'OPTIONS' }),
      env,
      ctx,
    );

    expect(writeDataPoint.mock.calls.map(([point]) => point.blobs)).toEqual([
      ['svc', 'PATCH', '/messages/{id}/labels'],
      ['svc', 'GET', '/health'],
      ['svc', 'OPTIONS', '/messages'],
    ]);
    expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('secret');
  });

  it('returns the response when the binding is missing or the write fails', async () => {
    const worker = {
      async fetch() {
        return new Response(null, { status: 204 });
      },
    };
    const wrapped = withResponseMetrics(worker, 'cookie-web-search');

    await expect(wrapped.fetch(request, /** @type {any} */ ({}), ctx)).resolves.toHaveProperty(
      'status',
      204,
    );

    const failing = /** @type {any} */ ({
      RESPONSE_METRICS: {
        writeDataPoint() {
          throw new Error('Analytics Engine unavailable');
        },
      },
    });
    await expect(wrapped.fetch(request, failing, ctx)).resolves.toHaveProperty('status', 204);
  });

  it('records a handler failure as the 500 the client receives, and lets it through', async () => {
    vi.useFakeTimers();
    const writeDataPoint = vi.fn();
    const worker = {
      async fetch() {
        vi.advanceTimersByTime(7);
        throw new Error('boom');
      },
    };
    const env = /** @type {any} */ ({ RESPONSE_METRICS: { writeDataPoint } });

    await expect(withResponseMetrics(worker, 'svc').fetch(request, env, ctx)).rejects.toThrow(
      'boom',
    );
    expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
      indexes: ['svc'],
      blobs: ['svc', 'GET', '/messages'],
      doubles: [7, 500],
    });
  });

  it('preserves other triggers and leaves a worker without fetch untouched', () => {
    const scheduled = async () => undefined;
    expect(withResponseMetrics({ scheduled }, 'svc')).toEqual({ scheduled });
    const wrapped = withResponseMetrics({ scheduled, fetch: async () => new Response() }, 'svc');
    expect(wrapped.scheduled).toBe(scheduled);
  });
});
