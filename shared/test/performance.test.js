import { describe, expect, it, vi } from 'vitest';
import { createTimings, withRequestMetrics } from '../performance.js';

describe('request performance metrics', () => {
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
});
