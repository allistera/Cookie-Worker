// Vitest runs in Node, where the Workers runtime module does not exist. This
// stands in for the one export the repository uses.
export class WorkerEntrypoint {
  /** @param {any} ctx @param {any} env */
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
