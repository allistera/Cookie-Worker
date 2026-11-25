import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

// The claim/ack endpoint and its query-shape tests live with the
// cookie-web-notifications Worker. The browser_notification_events table,
// its trigger and the ntfy queue are created by these migrations, so their
// invariants are pinned here.
describe('browser notification events migration', () => {
  it('keeps notification tokens private, bounded and isolated from ingestion', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'migrations/0016_browser_notification_events.sql'),
      'utf8',
    );

    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL PRIVILEGES');
    expect(migration).toContain("created_at < clock_timestamp() - interval '24 hours'");
    expect(migration).toContain('EXCEPTION WHEN OTHERS');
    expect(migration).toContain(
      "jsonb_build_object('op', TG_OP, 'event_id', notification_event_id)",
    );
    expect(migration).toContain('SET search_path = pg_catalog');
  });

  it('keeps ntfy subscriptions and queued deliveries server-only', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'migrations/0077_ntfy_notifications.sql'),
      'utf8',
    );

    expect(migration).toContain('CREATE TABLE public.ntfy_subscriptions');
    expect(migration).toContain('CREATE TABLE public.ntfy_notification_events');
    expect(migration).toContain('ALTER TABLE public.ntfy_subscriptions ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL PRIVILEGES');
    expect(migration).toContain('ON CONFLICT (message_id) DO NOTHING');
  });
});
