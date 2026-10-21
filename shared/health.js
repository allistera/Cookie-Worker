// Public liveness only: aggregate readiness probes dependencies separately.
// Preserve every other handler/trigger on the worker.
export function withHealthCheck(worker) {
  return {
    ...worker,
    async fetch(request, env, ctx) {
      if (new URL(request.url).pathname !== '/health') return worker.fetch(request, env, ctx);
      const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
      if (request.method === 'GET') return Response.json({ status: 'ok' }, { headers });
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
      return Response.json(
        { error: 'Method not allowed' },
        {
          status: 405,
          headers: { ...headers, Allow: 'GET, HEAD' },
        },
      );
    },
  };
}
