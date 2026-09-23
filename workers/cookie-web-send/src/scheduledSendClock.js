// Exact-time delivery for "Send Later". One Durable Object, addressed by a
// fixed name, keeps a single alarm set to the earliest pending send. Queuing
// a send arms it (worker.js, in waitUntil); when it fires it runs the same
// claim-and-deliver core the flush route uses, then re-arms from the next
// pending row still in the future. Retries, expired leases and the
// housekeeping sweeps stay with the scheduled-send-flusher cron, so a send
// that keeps failing can never make this alarm spin, and a lost alarm costs
// at most one cron interval.

import { createSendServices, createSql } from './worker.js';
import { flushDueScheduledSends } from './scheduled.js';

export const CLOCK_NAME = 'scheduled-sends';

export class ScheduledSendClock {
  /**
   * Only the alarm storage and waitUntil of DurableObjectState are used, so
   * that is all the type asks for; tests pass a fake with just those.
   * @param {{storage: {getAlarm: () => Promise<number | null>, setAlarm: (at: number) => Promise<void>}, waitUntil: (promise: Promise<unknown>) => void}} state
   * @param {any} env
   * @param {{createSql?: typeof createSql, flush?: typeof flushDueScheduledSends, createServices?: (env: any, ctx: any) => import('./outbound.js').SendServices}} [deps]
   */
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.deps = {
      createSql: deps.createSql ?? createSql,
      flush: deps.flush ?? flushDueScheduledSends,
      createServices: deps.createServices ?? createSendServices,
    };
  }

  /**
   * POST /arm with `{ at: <ISO timestamp> }`: alarm moves earlier, never later.
   * @param {Request} request
   */
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/arm' || request.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }
    /** @type {any} */
    let body;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const at = Date.parse(String(body?.at ?? ''));
    if (Number.isNaN(at)) {
      return Response.json({ error: 'at must be an ISO timestamp' }, { status: 400 });
    }
    await this.armAt(at);
    return new Response(null, { status: 204 });
  }

  /** @param {number} at epoch ms; a time already gone fires now */
  async armAt(at) {
    const target = Math.max(at, Date.now());
    const current = await this.state.storage.getAlarm();
    if (current === null || current === undefined || target < current) {
      await this.state.storage.setAlarm(target);
    }
  }

  async alarm() {
    const sql = this.deps.createSql(this.env.HYPERDRIVE.connectionString);
    try {
      try {
        await this.deps.flush(
          sql,
          this.deps.createServices(this.env, /** @type {any} */ (this.state)),
        );
      } catch (err) {
        console.log(
          JSON.stringify({
            event: 'scheduled_send_alarm_failed',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      await this.rearmFromDatabase(sql);
    } finally {
      await sql.end({ timeout: 2 }).catch(() => undefined);
    }
  }

  /**
   * The next send still ahead of us. Rows already due but not yet delivered
   * (a retry, an expired lease) are the cron's, not the alarm's.
   * @param {import('postgres').Sql} sql
   */
  async rearmFromDatabase(sql) {
    const [row] = await sql`
      SELECT min(scheduled_for) AS next
      FROM scheduled_sends
      WHERE status = 'pending' AND scheduled_for > now()
    `;
    const next = row?.next ? new Date(row.next).getTime() : NaN;
    if (!Number.isNaN(next)) await this.armAt(next);
  }
}
