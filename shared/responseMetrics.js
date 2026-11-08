// One Analytics Engine data point per HTTP response: which Worker answered,
// how long it took, and with what status. The fixed service name is the only
// index and blob; never record URLs, identities, headers or payloads. Every
// wrangler.jsonc binds the shared `cookie_response_times` dataset as
// RESPONSE_METRICS. Preserve every other handler/trigger on the worker.
export function withResponseMetrics(worker, service) {
  if (typeof worker.fetch !== 'function') return worker;
  return {
    ...worker,
    async fetch(request, env, ctx) {
      const started = Date.now();
      const response = await worker.fetch(request, env, ctx);
      try {
        env.RESPONSE_METRICS.writeDataPoint({
          indexes: [service],
          blobs: [service],
          doubles: [Date.now() - started, response.status],
        });
      } catch {
        // Metrics must not prevent the response from being returned.
      }
      return response;
    },
  };
}
