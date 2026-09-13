// Only fixed operation names, status codes and durations. Never record URLs,
// tokens, mailbox IDs, message content or SQL parameters.
export function createTimings() {
  const stages = [];
  return {
    async run(name, operation) {
      const start = performance.now();
      try {
        return await operation();
      } finally {
        stages.push(`${name};dur=${(performance.now() - start).toFixed(2)}`);
      }
    },
    response(response) {
      if (stages.length) response.headers.set('Server-Timing', stages.join(', '));
      return response;
    },
  };
}

export function withRequestMetrics(worker, service) {
  return {
    ...worker,
    async fetch(request, env, ctx) {
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
      headers.set('Access-Control-Expose-Headers', 'Server-Timing');
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
