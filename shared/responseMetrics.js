import { routeTemplate } from './tracing.js';

// One Analytics Engine data point per HTTP request: which Worker answered,
// which method and route, how long it took, and with what status. The route
// is the template (`/messages/{id}`), so health probes and preflights can be
// told apart from real traffic and no identifier is stored; never record
// query strings, identities, headers or payloads. Every wrangler.jsonc binds
// the shared `cookie_response_times` dataset as RESPONSE_METRICS. Preserve
// every other handler/trigger on the worker.
export function withResponseMetrics(worker, service) {
  if (typeof worker.fetch !== 'function') return worker;
  return {
    ...worker,
    async fetch(request, env, ctx) {
      const started = Date.now();
      // A handler that throws never returns a status; Cloudflare answers the
      // client with a 500, so that is what the point records.
      let status = 500;
      try {
        const response = await worker.fetch(request, env, ctx);
        status = response.status;
        return response;
      } finally {
        try {
          env.RESPONSE_METRICS.writeDataPoint({
            indexes: [service],
            blobs: [service, request.method, routeTemplate(new URL(request.url).pathname)],
            doubles: [Date.now() - started, status],
          });
        } catch {
          // Metrics must not prevent the response from being returned.
        }
      }
    },
  };
}
