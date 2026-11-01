// Node has no Workers runtime module. scripts/build-aws.mjs points `cloudflare:workers` here when it
// bundles the AWS server, and shared/tracing.js only needs `tracing`. Cloudflare's automatic traces
// have no AWS counterpart, so every span call is a no-op, as for a request that is not sampled.
export const tracing = {
  getActiveSpan: () => undefined,
  /** @param {string} _name */
  startSpan: (_name) => undefined,
};
