import { readFile } from 'node:fs/promises';
import process from 'node:process';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDraftStar } from '../../cookie-web-drafts/src/drafts.js';
import { purgeExpiredDrafts } from '../src/draftRetentionSweep.js';

const databaseUrl = process.env.SCREENING_RETENTION_TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl)
  throw new Error(
    'CI must provide the disposable retention database; draft retention coverage may not be skipped',
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

const SCHEMA = 'draft_retention_fixture';
const OWNER = '11111111-1111-4111-8111-111111111111';
const EXISTING = '22222222-2222-4222-8222-222222222222';
const STARRED = '33333333-3333-4333-8333-333333333333';
const EDITED = '44444444-4444-4444-8444-444444444444';
const UNSTARRED = '55555555-5555-4555-8555-555555555555';

function connect(applicationName) {
  if (!databaseUrl) throw new Error('Disposable retention database is not configured');
  return postgres(databaseUrl, {
    max: 1,
    connection: {
      application_name: applicationName,
      search_path: SCHEMA,
      statement_timeout: 10000,
    },
  });
}

function sweep() {
  return purgeExpiredDrafts(
    { HYPERDRIVE: { connectionString: databaseUrl } },
    { createSql: () => connect('draft-retention-sweep') },
  );
}

describe.skipIf(!databaseUrl)('draft retention on PostgreSQL', () => {
  /** @type {import('postgres').Sql} */
  let observer;
  const remaining = async () =>
    (await observer`SELECT id FROM drafts ORDER BY id`).map((row) => row.id);

  beforeAll(async () => {
    observer = connect('draft-retention-observer');
    // The columns of drafts the sweep and the star handler touch, as they stood
    // before migration 0119, which is then applied from its own file.
    await observer.unsafe(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE drafts (id uuid PRIMARY KEY, user_id uuid NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO drafts (id, user_id, updated_at)
        VALUES ('${EXISTING}', '${OWNER}', now() - interval '90 days');
    `);
    const migration = await readFile(
      new URL('../../../migrations/0119_draft_retention.sql', import.meta.url),
      'utf8',
    );
    await observer.unsafe(migration.replaceAll('public.', `${SCHEMA}.`));
  });
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (observer) await observer.end();
  });

  it('gives a draft that predates the rule 30 days from the migration', async () => {
    await sweep();
    expect(await remaining()).toEqual([EXISTING]);

    await observer`UPDATE drafts SET retention_from = now() - interval '31 days'`;
    await sweep();
    expect(await remaining()).toEqual([]);
  });

  it('keeps starred, recently saved and just unstarred drafts', async () => {
    await observer`DELETE FROM drafts`;
    await observer`INSERT INTO drafts (id, user_id, updated_at, retention_from, is_starred) VALUES
      (${EXISTING}, ${OWNER}, now() - interval '31 days', now() - interval '90 days', false),
      (${STARRED}, ${OWNER}, now() - interval '90 days', now() - interval '90 days', true),
      (${EDITED}, ${OWNER}, now() - interval '29 days', now() - interval '90 days', false),
      (${UNSTARRED}, ${OWNER}, now() - interval '90 days', now() - interval '90 days', true)`;
    const [before] = await observer`SELECT updated_at FROM drafts WHERE id = ${UNSTARRED}`;

    expect((await setDraftStar(observer, OWNER, UNSTARRED, { starred: false })).status).toBe(200);
    await sweep();

    expect(await remaining()).toEqual([STARRED, EDITED, UNSTARRED]);
    // The star is not an edit: the version autosave checks stays as it was.
    const [after] = await observer`SELECT updated_at FROM drafts WHERE id = ${UNSTARRED}`;
    expect(after.updated_at).toEqual(before.updated_at);
  });

  it('keeps a draft starred while the sweep waits for its row', async () => {
    await observer`DELETE FROM drafts`;
    await observer`INSERT INTO drafts (id, user_id, updated_at, retention_from) VALUES
      (${EXISTING}, ${OWNER}, now() - interval '90 days', now() - interval '90 days')`;
    const starrer = connect('draft-retention-starrer');
    const locked = Promise.withResolvers();
    const release = Promise.withResolvers();
    let starrerPid = 0;
    const star = starrer.begin(async (tx) => {
      await setDraftStar(/** @type {any} */ (tx), OWNER, EXISTING, { starred: true });
      const [session] = await tx`SELECT pg_backend_pid() AS pid`;
      starrerPid = session.pid;
      locked.resolve(undefined);
      await release.promise;
    });
    void star.catch((error) => locked.reject(error));
    let running = Promise.resolve();
    try {
      await locked.promise;
      running = sweep();
      await vi.waitFor(
        async () => {
          const waiting = await observer`SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND application_name = 'draft-retention-sweep'
              AND wait_event_type = 'Lock' AND ${starrerPid} = ANY(pg_blocking_pids(pid))`;
          expect(waiting).toHaveLength(1);
        },
        { timeout: 5000, interval: 20 },
      );
      release.resolve(undefined);
      await star;
      await running;
      expect(await remaining()).toEqual([EXISTING]);
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([star, running]);
      await starrer.end();
    }
  }, 15000);
});
