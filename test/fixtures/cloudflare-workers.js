// Vitest runs in Node, where the Workers runtime module does not exist. This
// stands in for the exports the repository uses.
export class WorkerEntrypoint {
  /** @param {any} ctx @param {any} env */
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

// No invocation is traced under Vitest, so shared/tracing.js stays a no-op
// unless a test mocks this module with a span of its own.
export const tracing = {
  getActiveSpan: () => undefined,
  /** @param {string} _name */
  startSpan: (_name) => undefined,
};
