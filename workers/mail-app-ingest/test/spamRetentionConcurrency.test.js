import process from 'node:process';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { putSenders } from '../../cookie-web-emails/src/senders.js';
import { purgeExpiredSpam } from '../src/spamRetentionSweep.js';

const databaseUrl = process.env.SCREENING_RETENTION_TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl)
  throw new Error(
    'CI must provide the disposable retention database; concurrency coverage may not be skipped',
  );
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/cookie_screening_retention_test' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Retention tests require the isolated loopback cookie_screening_retention_test database',
    );
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';
const BLOCKED = '33333333-3333-4333-8333-333333333333';
const ALLOWED = '44444444-4444-4444-8444-444444444444';

function connect(applicationName) {
  if (!databaseUrl) throw new Error('Disposable retention database is not configured');
  return postgres(databaseUrl, {
    max: 1,
    connection: {
      application_name: applicationName,
      search_path: 'screening_retention_fixture',
      statement_timeout: 10000,
    },
  });
}

describe.skipIf(!databaseUrl)('sender blocking versus retention on PostgreSQL', () => {
  /** @type {import('postgres').Sql} */
  let observer;
  beforeAll(async () => {
    observer = connect('screening-retention-observer');
    // Deliberately minimal post-0083 fixture: actual sender/retention handlers
    // execute their own SQL. Migration/trigger/privacy behavior is tested by
    // Cookie-Web's separate actual-0080/0082/0083 PostgreSQL CI fixture.
    await observer.unsafe(`
      CREATE SCHEMA screening_retention_fixture;
      CREATE TABLE users (id uuid PRIMARY KEY, prefs jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE threads (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id),
        ai_summary text, ai_summary_message_id uuid, ai_summary_updated_at timestamptz);
      CREATE TABLE messages (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
        thread_id uuid NOT NULL REFERENCES threads(id), from_address text NOT NULL,
        is_sent boolean NOT NULL DEFAULT false, is_deleted boolean NOT NULL DEFAULT false,
        is_archived boolean NOT NULL DEFAULT false, auto_reply_suppressed boolean NOT NULL DEFAULT false,
        screening_status text NOT NULL DEFAULT 'allowed', created_at timestamptz NOT NULL DEFAULT now(),
        search_indexed_at timestamptz);
      CREATE TABLE message_ai (message_id uuid PRIMARY KEY REFERENCES messages(id), spam_verdict text, processed_at timestamptz);
      CREATE TABLE sender_decisions (user_id uuid REFERENCES users(id), address text, decision text,
        updated_at timestamptz DEFAULT now(), PRIMARY KEY(user_id, address));
      CREATE TABLE browser_notification_events (user_id uuid, message_id uuid);
      CREATE TABLE ntfy_notification_events (user_id uuid, message_id uuid, published_at timestamptz);
    `);
  });
  beforeEach(async () => {
    await observer.unsafe(`TRUNCATE message_ai, messages, threads, users, sender_decisions,
      browser_notification_events, ntfy_notification_events CASCADE`);
    await observer`INSERT INTO users(id) VALUES (${OWNER})`;
    await observer`INSERT INTO threads(id, user_id) VALUES (${THREAD}, ${OWNER})`;
    await observer`INSERT INTO messages(id, user_id, thread_id, from_address) VALUES
      (${BLOCKED}, ${OWNER}, ${THREAD}, 'sender@example.com'),
      (${ALLOWED}, ${OWNER}, ${THREAD}, 'other@example.com')`;
    await observer`INSERT INTO message_ai(message_id, spam_verdict, processed_at) VALUES
      (${BLOCKED}, 'spam', now() - interval '61 days'),
      (${ALLOWED}, 'spam', now() - interval '60 days')`;
  });
  afterAll(async () => {
    if (observer) await observer.end();
  });

  it('keeps mail recoverable when the actual sweep waits behind Block, but still purges allowed spam', async () => {
    const blocker = connect('screening-retention-blocker');
    const locked = Promise.withResolvers();
    const release = Promise.withResolvers();
    let blockerPid = 0;
    // Only delay the commit boundary; do not replace any Block query or lock.
    const pausedBlock = /** @type {any} */ ({
      begin: (callback) =>
        blocker.begin(async (tx) => {
          const response = await callback(tx);
          const [session] = await tx`SELECT pg_backend_pid() AS pid`;
          blockerPid = session.pid;
          locked.resolve(undefined);
          await release.promise;
          return response;
        }),
    });
    const block = putSenders(pausedBlock, OWNER, {
      action: 'block',
      address: 'sender@example.com',
      messageId: BLOCKED,
    });
    // Ensure setup failures surface rather than leaving the ready gate hanging.
    void block.catch((error) => locked.reject(error));
    let sweep = Promise.resolve();
    try {
      await locked.promise;
      let sweepFinished = false;
      sweep = purgeExpiredSpam(
        { HYPERDRIVE: { connectionString: databaseUrl } },
        {
          createSql: () => connect('screening-retention-sweep'),
        },
      ).then(() => {
        sweepFinished = true;
      });
      // Observe a real PostgreSQL lock wait behind this exact Block transaction.
      // No arbitrary sleep can accidentally let the sweep start after commit.
      await vi.waitFor(
        async () => {
          expect(sweepFinished).toBe(false);
          const waiting = await observer`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = 'screening-retention-sweep'
            AND wait_event_type = 'Lock' AND ${blockerPid} = ANY(pg_blocking_pids(pid))`;
          expect(waiting).toHaveLength(1);
        },
        { timeout: 5000, interval: 20 },
      );
      release.resolve(undefined);
      expect((await block).status).toBe(200);
      await sweep;
      const messages =
        await observer`SELECT id, screening_status, is_deleted FROM messages ORDER BY id`;
      expect(messages).toEqual([
        { id: BLOCKED, screening_status: 'blocked', is_deleted: false },
        { id: ALLOWED, screening_status: 'allowed', is_deleted: true },
      ]);
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([block, sweep]);
      await blocker.end();
    }
  }, 15000);
});
