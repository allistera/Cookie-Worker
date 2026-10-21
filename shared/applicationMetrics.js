import { metrics } from '@sentry/cloudflare';

const names = new Set(['worker.invocations', 'worker.duration']);
const triggers = new Set(['fetch', 'scheduled', 'email', 'queue']);

/**
 * @param {import('@sentry/core').Metric} metric
 * @param {string} service
 * @returns {import('@sentry/core').Metric | null}
 */
export function sanitizeMetric(metric, service) {
  if (!names.has(metric.name) || !Number.isFinite(metric.value) || metric.value < 0) return null;
  const source = metric.attributes ?? {};
  return {
    name: metric.name,
    value: metric.value,
    type: metric.name === 'worker.invocations' ? 'counter' : 'distribution',
    ...(metric.name === 'worker.duration' ? { unit: 'millisecond' } : {}),
    attributes: {
      service,
      trigger:
        typeof source.trigger === 'string' && triggers.has(source.trigger)
          ? source.trigger
          : 'fetch',
      outcome:
        typeof source.outcome === 'string' && ['success', 'error'].includes(source.outcome)
          ? source.outcome
          : 'error',
      ...(typeof source.status === 'number' &&
      Number.isInteger(source.status) &&
      source.status >= 100 &&
      source.status <= 599
        ? { status: source.status }
        : {}),
    },
  };
}

// Installed inside withSentry so metrics use the invocation's client and are
// flushed by the SDK's existing execution-context lifecycle. Never read URLs,
// message bodies, queue payloads or user identity for metric attributes.
export function withApplicationMetrics(worker, service) {
  const instrumented = { ...worker };
  for (const trigger of triggers) {
    if (typeof worker[trigger] !== 'function') continue;
    instrumented[trigger] = async function (...args) {
      const started = performance.now();
      let outcome = 'error';
      let status;
      try {
        const result = await worker[trigger].apply(worker, args);
        if (trigger === 'fetch' && result instanceof Response) status = result.status;
        outcome = status >= 500 ? 'error' : 'success';
        return result;
      } finally {
        try {
          const attributes = { service, trigger, outcome, ...(status ? { status } : {}) };
          metrics.count('worker.invocations', 1, { attributes });
          metrics.distribution('worker.duration', performance.now() - started, {
            unit: 'millisecond',
            attributes,
          });
        } catch {
          // Optional monitoring must never change a response or thrown error.
        }
      }
    };
  }
  return instrumented;
}
