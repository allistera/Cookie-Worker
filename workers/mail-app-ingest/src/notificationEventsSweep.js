import { retryWithFreshClient } from '../../../shared/transient-db.js';
import { captureHandledException } from './sentry.js';

/**
 * Drops browser and ntfy notification events older than a day. Both queues
 * exist only so a client can claim a fresh event; anything a day old has
 * either been delivered or is not worth surfacing. Until migration 0080 the
 * notify_inbox_changed() trigger ran these deletes inside every inbound
 * INSERT, spending the ingest's store budget on housekeeping; the cron does
 * it now, alongside the other sweeps.
 *
 * Errors are logged and swallowed so the tick survives; a dropped Hyperdrive
 * socket gets a fresh client and another go, which is safe because the
 * statements are idempotent.
 *
 * @param {any} env
 * @param {{createSql?: (url: string) => any}} [deps]
 */
export async function purgeExpiredNotificationEvents(env, deps = {}) {
  const makeSql = deps.createSql;
  if (!makeSql) {
    console.log(JSON.stringify({ event: 'notification_events_purge_misconfigured' }));
    return;
  }

  try {
    const { browser, ntfy } = await retryWithFreshClient(
      () => makeSql(env.HYPERDRIVE.connectionString),
      async (sql) => {
        const browserRows = await sql`
          DELETE FROM browser_notification_events
          WHERE created_at < now() - interval '24 hours'
          RETURNING event_id
        `;
        const ntfyRows = await sql`
          DELETE FROM ntfy_notification_events
          WHERE created_at < now() - interval '24 hours'
          RETURNING event_id
        `;
        return { browser: browserRows.length, ntfy: ntfyRows.length };
      },
    );
    if (browser || ntfy) {
      console.log(JSON.stringify({ event: 'notification_events_purged', browser, ntfy }));
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        event: 'notification_events_purge_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    captureHandledException('notification_events_purge', err, [env.HYPERDRIVE.connectionString]);
  }
}
