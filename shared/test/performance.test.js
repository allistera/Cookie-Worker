import { describe, expect, it, vi } from 'vitest';
import { createTracingRecorder } from '../../test/fixtures/tracing-recorder.js';

const recorder = vi.hoisted(() => ({ current: /** @type {any} */ (null) }));

vi.mock('cloudflare:workers', () => ({
  tracing: {
    getActiveSpan: () => recorder.current?.tracing.getActiveSpan(),
    /** @param {string} name */
    startSpan: (name) => recorder.current?.tracing.startSpan(name),
  },
}));

const { createTimings, withRequestMetrics } = await import('../performance.js');

describe('request performance metrics', () => {
  it('names the invocation span after the route template, never the identifier', async () => {
    recorder.current = createTracingRecorder();
    try {
      const worker = withRequestMetrics(
        {
          async fetch() {
            return new Response(null);
          },
        },
        'tasks',
      );
      await worker.fetch(
        new Request(
          'https://private.invalid/tasks/7f3a1c2e-9b4d-4e8f-a1b2-c3d4e5f6a7b8?token=secret',
          {
            method: 'PATCH',
          },
        ),
        { PERFORMANCE_SAMPLE_RATE: 0 },
        {},
      );
      expect(recorder.current.root.name).toBe('PATCH /tasks/{id}');
      expect(recorder.current.root.attributes).toEqual({ 'http.route': '/tasks/{id}' });
      expect(JSON.stringify(recorder.current.root)).not.toContain('7f3a1c2e');
    } finally {
      recorder.current = null;
    }
  });

  it('preserves response data and records only fixed labels and timings', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const worker = withRequestMetrics(
        {
          async fetch() {
            const timer = createTimings();
            const value = await timer.run('list', async () => ({ ok: true }));
            return timer.response(Response.json(value));
          },
        },
        'emails',
      );
      const response = await worker.fetch(
        new Request('https://private.invalid/?id=secret', {
          headers: { Authorization: 'Bearer secret-token' },
        }),
        { PERFORMANCE_SAMPLE_RATE: 1 },
        {},
      );
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get('Server-Timing')).toMatch(/list;dur=.+total;dur=/);
      const record = JSON.parse(log.mock.calls[0][0]);
      expect(Object.keys(record).sort()).toEqual([
        'duration_ms',
        'event',
        'method',
        'service',
        'status',
      ]);
      expect(JSON.stringify(record)).not.toContain('secret');
    } finally {
      log.mockRestore();
    }
  });

  it('keeps headers the handler already exposed', async () => {
    const expose = async (value) => {
      const worker = withRequestMetrics(
        {
          async fetch() {
            const headers = new Headers();
            if (value) headers.set('Access-Control-Expose-Headers', value);
            return new Response(null, { status: 429, headers });
          },
        },
        'notifications',
      );
      const response = await worker.fetch(new Request('https://x.invalid/'), {
        PERFORMANCE_SAMPLE_RATE: 0,
      });
      return response.headers.get('Access-Control-Expose-Headers');
    };
    expect(await expose('Retry-After')).toBe('Retry-After, Server-Timing');
    expect(await expose('server-timing, Retry-After')).toBe('server-timing, Retry-After');
    expect(await expose(null)).toBe('Server-Timing');
  });
});
