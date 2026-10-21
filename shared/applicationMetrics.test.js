import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  metrics: { count: vi.fn(), distribution: vi.fn() },
}));
import { metrics } from '@sentry/cloudflare';
import { sanitizeMetric, withApplicationMetrics } from './applicationMetrics.js';

beforeEach(() => vi.resetAllMocks());

describe('application metrics', () => {
  it('supplies safe defaults when attributes are missing', () => {
    expect(
      sanitizeMetric({ name: 'worker.invocations', value: 1, type: 'counter' }, 'worker'),
    ).toEqual({
      name: 'worker.invocations',
      value: 1,
      type: 'counter',
      attributes: { service: 'worker', trigger: 'fetch', outcome: 'error' },
    });
  });

  it.each([undefined, '200', 200.5, 99, 600])('drops invalid status %s', (status) => {
    expect(
      sanitizeMetric(
        {
          name: 'worker.duration',
          value: 0,
          type: 'distribution',
          attributes: { status, trigger: 'unknown', outcome: 'unknown' },
        },
        'worker',
      )?.attributes,
    ).toEqual({ service: 'worker', trigger: 'fetch', outcome: 'error' });
  });

  it.each(['fetch', 'scheduled', 'email', 'queue'])(
    'measures %s and preserves arguments and results',
    async (trigger) => {
      const result = trigger === 'fetch' ? new Response('ok', { status: 202 }) : undefined;
      const handler = vi.fn().mockResolvedValue(result);
      const worker = { [trigger]: handler };
      const args = [{ private: 'mail content' }, {}, {}];
      expect(await withApplicationMetrics(worker, 'test-worker')[trigger](...args)).toBe(result);
      expect(handler).toHaveBeenCalledWith(...args);
      expect(metrics.count).toHaveBeenCalledExactlyOnceWith('worker.invocations', 1, {
        attributes: {
          service: 'test-worker',
          trigger,
          outcome: 'success',
          ...(trigger === 'fetch' ? { status: 202 } : {}),
        },
      });
      expect(metrics.distribution).toHaveBeenCalledWith('worker.duration', expect.any(Number), {
        unit: 'millisecond',
        attributes: expect.objectContaining({ trigger }),
      });
      expect(JSON.stringify(vi.mocked(metrics.count).mock.calls)).not.toContain('mail content');
    },
  );

  it('records HTTP failures and preserves thrown errors', async () => {
    const error = new Error('private failure');
    const worker = withApplicationMetrics(
      {
        fetch: () => new Response(null, { status: 503 }),
        scheduled: () => {
          throw error;
        },
      },
      'test-worker',
    );
    expect((await worker.fetch()).status).toBe(503);
    await expect(worker.scheduled()).rejects.toBe(error);
    expect(metrics.count).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(metrics.count).mock.calls)
      expect(call[2]?.attributes?.outcome).toBe('error');
  });

  it('keeps monitoring failures from breaking handlers and does not invent triggers', async () => {
    vi.mocked(metrics.count).mockImplementation(() => {
      throw new Error('SDK unavailable');
    });
    const response = new Response('ok');
    const worker = withApplicationMetrics({ fetch: () => response }, 'test-worker');
    expect(await worker.fetch()).toBe(response);
    expect(worker.scheduled).toBeUndefined();
  });

  it('allowlists metric attributes and drops unknown metrics and invalid values', () => {
    const input = {
      name: 'worker.duration',
      value: 12,
      type: /** @type {const} */ ('distribution'),
      attributes: {
        trigger: 'email',
        outcome: 'success',
        status: 200,
        'user.email': 'private@example.com',
        url: 'secret',
      },
    };
    expect(sanitizeMetric(input, 'ingest')).toEqual({
      name: 'worker.duration',
      value: 12,
      type: 'distribution',
      unit: 'millisecond',
      attributes: { service: 'ingest', trigger: 'email', outcome: 'success', status: 200 },
    });
    expect(sanitizeMetric({ ...input, name: 'private' }, 'ingest')).toBeNull();
    expect(sanitizeMetric({ ...input, value: NaN }, 'ingest')).toBeNull();
    expect(sanitizeMetric({ ...input, value: -1 }, 'ingest')).toBeNull();
  });
});
