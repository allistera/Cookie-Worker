import { afterEach, describe, expect, it, vi } from 'vitest';
import { withResponseMetrics } from './responseMetrics.js';

const request = new Request('https://worker.example/messages');
const ctx = /** @type {any} */ ({ waitUntil: () => undefined });

afterEach(() => vi.useRealTimers());

describe('withResponseMetrics', () => {
  it('writes one data point per response with the service, duration and status', async () => {
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
      blobs: ['cookie-web-messages'],
      doubles: [42, 201],
    });
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

  it('lets a handler failure through without recording a point', async () => {
    const writeDataPoint = vi.fn();
    const worker = {
      async fetch() {
        throw new Error('boom');
      },
    };
    const env = /** @type {any} */ ({ RESPONSE_METRICS: { writeDataPoint } });

    await expect(withResponseMetrics(worker, 'svc').fetch(request, env, ctx)).rejects.toThrow(
      'boom',
    );
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('preserves other triggers and leaves a worker without fetch untouched', () => {
    const scheduled = async () => undefined;
    expect(withResponseMetrics({ scheduled }, 'svc')).toEqual({ scheduled });
    const wrapped = withResponseMetrics({ scheduled, fetch: async () => new Response() }, 'svc');
    expect(wrapped.scheduled).toBe(scheduled);
  });
});
