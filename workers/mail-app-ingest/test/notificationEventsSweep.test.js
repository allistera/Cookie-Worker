import { afterEach, describe, expect, it, vi } from 'vitest';

const { captureHandledException } = vi.hoisted(() => ({ captureHandledException: vi.fn() }));
vi.mock('../src/sentry.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, captureHandledException };
});

import { purgeExpiredNotificationEvents } from '../src/notificationEventsSweep.js';

const ENV = { HYPERDRIVE: { connectionString: 'postgres://user:pass@example/db' } };

/** @param {unknown[][]} results */
function createMockSql(results = []) {
  const queue = [...results];
  /** @type {{text: string, values: unknown[]}[]} */
  const calls = [];
  /** @type {any} */
  const sql = vi.fn((/** @type {any} */ strings, /** @type {unknown[]} */ ...values) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(queue.length ? queue.shift() : []);
  });
  sql.calls = calls;
  sql.end = vi.fn().mockResolvedValue(undefined);
  return sql;
}

// Until migration 0080 these deletes ran inside notify_inbox_changed() on
// every inbound INSERT, inside the ingest's store budget. They belong on the
// cron: day-old rows can wait fifteen minutes.
describe('purgeExpiredNotificationEvents', () => {
  afterEach(() => {
    vi.useRealTimers();
    captureHandledException.mockClear();
  });

  it('deletes day-old browser and ntfy notification events and closes its client', async () => {
    const sql = createMockSql([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await purgeExpiredNotificationEvents(ENV, { createSql: () => sql });

    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[0].text).toContain('DELETE FROM browser_notification_events');
    expect(sql.calls[0].text).toContain("created_at < now() - interval '24 hours'");
    expect(sql.calls[1].text).toContain('DELETE FROM ntfy_notification_events');
    expect(sql.calls[1].text).toContain("created_at < now() - interval '24 hours'");
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'notification_events_purged', browser: 2, ntfy: 1 }),
    );
    expect(sql.end).toHaveBeenCalled();
    log.mockRestore();
  });

  it('stays quiet on a tick that finds nothing', async () => {
    const sql = createMockSql([[], []]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await purgeExpiredNotificationEvents(ENV, { createSql: () => sql });

    expect(log).not.toHaveBeenCalled();
    expect(sql.end).toHaveBeenCalled();
    log.mockRestore();
  });

  it('reports a failed sweep without throwing, so the cron tick survives', async () => {
    const sql = createMockSql();
    sql.mockRejectedValueOnce(new Error('connection reset'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      purgeExpiredNotificationEvents(ENV, { createSql: () => sql }),
    ).resolves.toBeUndefined();

    expect(captureHandledException).toHaveBeenCalledWith(
      'notification_events_purge',
      expect.any(Error),
      [ENV.HYPERDRIVE.connectionString],
    );
    expect(sql.end).toHaveBeenCalled();
    log.mockRestore();
  });

  it('logs rather than throws when no sql factory is injected', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await purgeExpiredNotificationEvents(ENV);

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'notification_events_purge_misconfigured' }),
    );
    log.mockRestore();
  });
});
