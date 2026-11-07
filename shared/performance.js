import { labelRequestSpan } from './tracing.js';

// Only fixed operation names, status codes and durations. Never record URLs,
// tokens, mailbox IDs, message content or SQL parameters.
// A stage run more than once (verified search pagination queries Meilisearch
// and hydrates from Postgres per batch) is reported once, with its durations
// summed, so Server-Timing stays one entry per stage.
export function createTimings() {
  /** @type {Map<string, number>} */
  const stages = new Map();
  return {
    async run(name, operation) {
      const start = performance.now();
      try {
        return await operation();
      } finally {
        stages.set(name, (stages.get(name) ?? 0) + (performance.now() - start));
      }
    },
    response(response) {
      if (stages.size) {
        response.headers.set(
          'Server-Timing',
          [...stages].map(([name, duration]) => `${name};dur=${duration.toFixed(2)}`).join(', '),
        );
      }
      return response;
    },
  };
}

export function withRequestMetrics(worker, service) {
  return {
    ...worker,
    async fetch(request, env, ctx) {
      labelRequestSpan(request);
      const start = performance.now();
      const response = await worker.fetch(request, env, ctx);
      if (request.method === 'OPTIONS') return response;
      const duration = performance.now() - start;
      const headers = new Headers(response.headers);
      const stages = headers.get('Server-Timing');
      headers.set(
        'Server-Timing',
        `${stages ? `${stages}, ` : ''}total;dur=${duration.toFixed(2)}`,
      );
      headers.set(
        'Access-Control-Expose-Headers',
        appendHeaderToken(headers.get('Access-Control-Expose-Headers'), 'Server-Timing'),
      );
      const rate = Number(env.PERFORMANCE_SAMPLE_RATE ?? 0.05);
      if (Number.isFinite(rate) && Math.random() < Math.max(0, Math.min(1, rate))) {
        console.log(
          JSON.stringify({
            event: 'request_performance',
            service,
            method: request.method,
            status: response.status,
            duration_ms: Math.round(duration * 100) / 100,
          }),
        );
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}

// Adds `token` to a comma-separated header list unless it is already there, so
// headers a handler exposed itself (such as Retry-After) stay readable.
function appendHeaderToken(value, token) {
  const tokens = (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!tokens.some((part) => part.toLowerCase() === token.toLowerCase())) tokens.push(token);
  return tokens.join(', ');
}
