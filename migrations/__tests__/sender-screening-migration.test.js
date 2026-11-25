import { readFile } from 'node:fs/promises';
import process from 'node:process';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.SCREENING_TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl)
  throw new Error(
    'CI must provide the disposable screening database; migration coverage may not be skipped',
  );
// Only the disposable, specifically named loopback CI database may run this
// fixture. Never reuse DATABASE_URL or a configured Supabase connection.
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/cookie_screening_test'
  )
    throw new Error(
      'Screening migration tests require the isolated localhost cookie_screening_test database',
    );
}
// Applies a migration the way migrations/migrate.sh does: its bare column-0
// BEGIN;/COMMIT; wrapper is stripped and the body runs in one transaction.
// (postgres.js refuses raw transaction control on a pooled client.)
async function applyMigration(sql, name) {
  const file = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const body = file.replace(/^(BEGIN|COMMIT);[ \t]*$/gm, '');
  await sql.begin((tx) => tx.unsafe(body));
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';
const OTHER_THREAD = '44444444-4444-4444-8444-444444444444';

describe.skipIf(!databaseUrl)('sender screening and private inbox pings on PostgreSQL', () => {
  let sql;
  beforeAll(async () => {
    sql = postgres(databaseUrl, { max: 2 });
    // Minimum pre-0088 public contract. Read and execute the shipped migration,
    // not a JavaScript imitation of its trigger/notification behavior.
    await sql.unsafe(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE public.users (id uuid PRIMARY KEY, auth0_sub text UNIQUE, prefs jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE public.threads (id uuid PRIMARY KEY, user_id uuid REFERENCES public.users(id), is_muted boolean NOT NULL DEFAULT false);
      CREATE TABLE public.messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.users(id),
        thread_id uuid NOT NULL REFERENCES public.threads(id), from_address text NOT NULL,
        body_text text, body_html text, message_id text, is_sent boolean NOT NULL DEFAULT false, is_deleted boolean NOT NULL DEFAULT false,
        is_unread boolean NOT NULL DEFAULT true, is_archived boolean NOT NULL DEFAULT false,
        sent_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), search_indexed_at timestamptz,
        search tsvector GENERATED ALWAYS AS (to_tsvector('simple', from_address)) STORED
      );
      CREATE EXTENSION pg_trgm;
      CREATE INDEX messages_from_address_trgm_idx ON public.messages USING gin (from_address gin_trgm_ops);
      CREATE TABLE public.documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now(),
        search tsvector GENERATED ALWAYS AS (to_tsvector('simple', title)) STORED
      );
      CREATE INDEX documents_user_updated_idx ON public.documents (user_id, updated_at DESC);
      CREATE TABLE public.document_files (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), folder_id uuid);
      CREATE UNIQUE INDEX messages_message_id_owner_idx ON public.messages(user_id, message_id) WHERE message_id IS NOT NULL;
      CREATE TABLE public.message_ai (message_id uuid PRIMARY KEY REFERENCES public.messages(id), spam_verdict text);
      CREATE TABLE public.browser_notification_events (event_id uuid DEFAULT gen_random_uuid(), user_id uuid, message_id uuid);
      CREATE TABLE public.ntfy_subscriptions (user_id uuid PRIMARY KEY, enabled boolean);
      CREATE TABLE public.ntfy_notification_events (user_id uuid, message_id uuid UNIQUE);
      CREATE SCHEMA realtime;
      CREATE TABLE realtime.pings (payload jsonb, private boolean);
      CREATE FUNCTION realtime.send(jsonb, text, text, boolean) RETURNS void LANGUAGE sql AS
        'INSERT INTO realtime.pings (payload, private) VALUES ($1, $4)';
    `);
    await applyMigration(sql, '0080_quiet_inbox_ping.sql');
    await sql.unsafe(`CREATE TRIGGER messages_notify_inbox_changed AFTER INSERT OR UPDATE OR DELETE
      ON public.messages FOR EACH ROW EXECUTE FUNCTION public.notify_inbox_changed()`);
    await applyMigration(sql, '0082_out_of_office.sql');
    await applyMigration(sql, '0088_sender_screening.sql');
    await applyMigration(sql, '0089_sender_domain_decisions.sql');
    await applyMigration(sql, '0090_write_path_cleanup.sql');
    // Exercise the Supabase-only path, including its managed-table boundary.
    // Vanilla Postgres has no supautils policy exception, so an event trigger
    // refuses table ALTERs while allowing the policy DDL Supabase permits.
    await sql.unsafe(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
      $$;
      CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$
        SELECT current_setting('realtime.topic', true)
      $$;
      CREATE TABLE realtime.messages (extension text);
      ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA auth, realtime TO anon, authenticated;
      GRANT SELECT, INSERT ON realtime.messages TO anon, authenticated;
      CREATE FUNCTION public.reject_managed_realtime_alter() RETURNS event_trigger
      LANGUAGE plpgsql AS $$
      DECLARE command record;
      BEGIN
        FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF command.object_identity = 'realtime.messages' AND command.command_tag = 'ALTER TABLE' THEN
            RAISE EXCEPTION 'must be owner of table messages' USING ERRCODE = '42501';
          END IF;
        END LOOP;
      END;
      $$;
      CREATE EVENT TRIGGER reject_managed_realtime_alter ON ddl_command_end
        WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION public.reject_managed_realtime_alter();
    `);
    await applyMigration(sql, '0105_private_inbox_broadcasts.sql');
    await applyMigration(sql, '0108_inbox_ping_comparison.sql');
  });
  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE public.message_ai, public.messages, public.threads, public.users,
      public.sender_decisions, public.browser_notification_events, public.ntfy_notification_events,
      public.ntfy_subscriptions, realtime.pings, realtime.messages CASCADE`);
    await sql`INSERT INTO users(id, auth0_sub) VALUES (${OWNER}, 'auth0|owner'), (${OTHER}, 'auth0|other')`;
    await sql`INSERT INTO threads(id, user_id) VALUES (${THREAD}, ${OWNER}), (${OTHER_THREAD}, ${OTHER})`;
    await sql`INSERT INTO ntfy_subscriptions(user_id, enabled) VALUES (${OWNER}, true), (${OTHER}, true)`;
  });
  afterAll(async () => {
    if (sql) await sql.end();
  });

  async function arrive({
    user = OWNER,
    address = 'sender@example.com',
    messageId = crypto.randomUUID(),
    archived = false,
  } = {}) {
    const [message] =
      await sql`INSERT INTO messages(user_id, thread_id, from_address, message_id, is_archived)
      VALUES (${user}, ${user === OWNER ? THREAD : OTHER_THREAD}, ${address}, ${messageId}, ${archived})
      ON CONFLICT(user_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING *`;
    return message;
  }
  async function enable(user = OWNER) {
    await sql`UPDATE users SET prefs = jsonb_build_object('senderScreening', true) WHERE id = ${user}`;
  }
  async function decide(address, decision, user = OWNER) {
    await sql`INSERT INTO sender_decisions(user_id, address, decision) VALUES (${user}, ${address}, ${decision})`;
  }
  async function alerts() {
    return sql`SELECT (SELECT count(*)::int FROM browser_notification_events) AS browser,
      (SELECT count(*)::int FROM ntfy_notification_events) AS ntfy`;
  }

  it('installs private-channel authorization without altering the managed table', async () => {
    await expect(
      sql`ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY`,
    ).rejects.toMatchObject({ code: '42501' });
    const [table] =
      await sql`SELECT relrowsecurity FROM pg_class WHERE oid = 'realtime.messages'::regclass`;
    expect(table.relrowsecurity).toBe(true);
    await sql`INSERT INTO realtime.messages(extension) VALUES ('broadcast'), ('presence')`;
    const receive = (subject, topic) =>
      sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE authenticated`;
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: subject })}, true)`;
        await tx`SELECT set_config('realtime.topic', ${topic}, true)`;
        return tx`SELECT extension FROM realtime.messages`;
      });
    expect(await receive('auth0|owner', `inbox:${OWNER}`)).toEqual([{ extension: 'broadcast' }]);
    expect(await receive('auth0|owner', `inbox:${OTHER}`)).toEqual([]);
    expect(await receive('auth0|other', `inbox:${OWNER}`)).toEqual([]);
    expect(await receive('auth0|unknown', `inbox:${OWNER}`)).toEqual([]);
    await expect(
      sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE authenticated`;
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: 'auth0|owner' })}, true)`;
        await tx`SELECT set_config('realtime.topic', ${`inbox:${OWNER}`}, true)`;
        await tx`INSERT INTO realtime.messages(extension) VALUES ('broadcast')`;
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses to install a private-channel policy when managed RLS is disabled', async () => {
    const migration = await readFile(
      new URL('../0105_private_inbox_broadcasts.sql', import.meta.url),
      'utf8',
    );
    await expect(
      sql.begin(async (tx) => {
        await tx`DROP EVENT TRIGGER reject_managed_realtime_alter`;
        await tx`ALTER TABLE realtime.messages DISABLE ROW LEVEL SECURITY`;
        await tx.unsafe(migration.replace(/^(BEGIN|COMMIT);[ \t]*$/gm, ''));
      }),
    ).rejects.toThrow('realtime.messages must already have row level security enabled by Supabase');
  });

  it('defaults off, persists allowed mail, queues alerts once, and deduplicates an MTA retry', async () => {
    expect((await arrive({ messageId: 'retry-id' })).screening_status).toBe('allowed');
    expect(await arrive({ messageId: 'retry-id' })).toBeUndefined();
    expect(await alerts()).toEqual([{ browser: 1, ntfy: 1 }]);
    expect(await sql`SELECT count(*)::int AS count FROM messages`).toEqual([{ count: 1 }]);
  });
  it('withholds unknown and blocked arrivals before notification exposure without hiding refresh pings', async () => {
    await enable();
    await decide('blocked@example.com', 'blocked');
    const unknown = await arrive({ archived: true });
    const blocked = await arrive({ address: '  BLOCKED@EXAMPLE.COM  ' });
    expect(unknown).toMatchObject({
      screening_status: 'held',
      auto_reply_suppressed: true,
      is_archived: true,
      is_unread: true,
    });
    expect(blocked).toMatchObject({ screening_status: 'blocked', auto_reply_suppressed: true });
    expect(await alerts()).toEqual([{ browser: 0, ntfy: 0 }]);
    const pings = await sql`SELECT payload FROM realtime.pings`;
    expect(pings).toHaveLength(2);
    expect(pings.every((row) => !row.payload.event_id)).toBe(true);
  });
  it('recognizes only exact accepted addresses and keeps independent spam/archive state', async () => {
    await enable();
    await decide('sender@example.com', 'accepted');
    const accepted = await arrive({ address: ' Sender@Example.COM ', archived: true });
    await sql`INSERT INTO message_ai(message_id, spam_verdict) VALUES (${accepted.id}, 'spam')`;
    expect(accepted.screening_status).toBe('allowed');
    expect((await arrive({ address: 'sender+tag@example.com' })).screening_status).toBe('held');
    expect((await arrive({ address: 'other@example.com' })).screening_status).toBe('held');
    const [saved] = await sql`SELECT m.is_archived, m.is_unread, ai.spam_verdict FROM messages m
      JOIN message_ai ai ON ai.message_id = m.id WHERE m.id = ${accepted.id}`;
    expect(saved).toEqual({ is_archived: true, is_unread: true, spam_verdict: 'spam' });
  });
  it('keeps owner decisions separate and retains previous held mail after disabling screening', async () => {
    await decide('sender@example.com', 'blocked');
    expect((await arrive()).screening_status).toBe('blocked');
    expect((await arrive({ user: OTHER })).screening_status).toBe('allowed');
    await enable(OTHER);
    const held = await arrive({ user: OTHER, address: 'new@example.com' });
    await sql`UPDATE users SET prefs = '{}' WHERE id = ${OTHER}`;
    expect((await arrive({ user: OTHER, address: 'next@example.com' })).screening_status).toBe(
      'allowed',
    );
    expect(
      (await sql`SELECT screening_status FROM messages WHERE id = ${held.id}`)[0].screening_status,
    ).toBe('held');
  });
  it('restores held mail without replaying alerts, clearing suppression, or overwriting underlying flags', async () => {
    await enable();
    const held = await arrive({ archived: true });
    await sql`INSERT INTO message_ai(message_id, spam_verdict) VALUES (${held.id}, 'spam')`;
    await sql`UPDATE messages SET screening_status = 'allowed', search_indexed_at = NULL
      WHERE id = ${held.id} AND user_id = ${OWNER}`;
    const [restored] = await sql`SELECT m.screening_status, m.is_archived, m.is_unread,
      m.auto_reply_suppressed, ai.spam_verdict FROM messages m JOIN message_ai ai ON ai.message_id = m.id
      WHERE m.id = ${held.id}`;
    expect(restored).toEqual({
      screening_status: 'allowed',
      is_archived: true,
      is_unread: true,
      auto_reply_suppressed: true,
      spam_verdict: 'spam',
    });
    expect(await alerts()).toEqual([{ browser: 0, ntfy: 0 }]);
    expect((await arrive()).screening_status).toBe('held');
    expect(await sql`SELECT count(*)::int AS count FROM realtime.pings`).toEqual([{ count: 3 }]);
  });
  it('applies a domain decision to the domain and its subdomains, not lookalikes', async () => {
    await enable();
    await decide('@smarty.co.uk', 'accepted');
    await decide('@spam.example', 'blocked');
    expect((await arrive({ address: 'offers@smarty.co.uk' })).screening_status).toBe('allowed');
    expect((await arrive({ address: 'News@Email.Smarty.co.uk' })).screening_status).toBe('allowed');
    expect((await arrive({ address: 'x@notsmarty.co.uk' })).screening_status).toBe('held');
    expect((await arrive({ address: 'x@smarty.co.uk.evil.example' })).screening_status).toBe(
      'held',
    );
    expect(await arrive({ address: 'a@deep.spam.example' })).toMatchObject({
      screening_status: 'blocked',
      auto_reply_suppressed: true,
    });
    expect(await alerts()).toEqual([{ browser: 2, ntfy: 2 }]);
  });
  it('lets an exact address override its domain, and a subdomain override its parent', async () => {
    await enable();
    await decide('@badco.example', 'blocked');
    await decide('vip@badco.example', 'accepted');
    await decide('@help.badco.example', 'accepted');
    expect((await arrive({ address: 'vip@badco.example' })).screening_status).toBe('allowed');
    expect((await arrive({ address: 'spam@badco.example' })).screening_status).toBe('blocked');
    expect((await arrive({ address: 'desk@help.badco.example' })).screening_status).toBe('allowed');
    const [resolved] = await sql`SELECT address, decision
      FROM public.effective_sender_decision(${OWNER}, ${' Desk@HELP.badco.example '})`;
    expect(resolved).toEqual({ address: '@help.badco.example', decision: 'accepted' });
    expect(
      await sql`SELECT * FROM public.effective_sender_decision(${OTHER}, 'vip@badco.example')`,
    ).toEqual([]);
  });
  it('fails closed while preserving stored mail if a sender lookup fails', async () => {
    await sql.unsafe('ALTER TABLE public.sender_decisions RENAME TO sender_decisions_unavailable');
    try {
      expect(await arrive()).toMatchObject({
        screening_status: 'held',
        auto_reply_suppressed: true,
      });
      expect(await alerts()).toEqual([{ browser: 0, ntfy: 0 }]);
    } finally {
      await sql.unsafe(
        'ALTER TABLE public.sender_decisions_unavailable RENAME TO sender_decisions',
      );
    }
  });
  it('pings once per affected user for a multi-row UPDATE or DELETE', async () => {
    await arrive();
    await arrive();
    await arrive({ user: OTHER });
    await sql`TRUNCATE realtime.pings`;
    await sql`UPDATE messages SET is_unread = false`;
    await sql`DELETE FROM messages WHERE user_id = ${OWNER}`;
    await sql`UPDATE messages SET is_unread = true WHERE false`;
    const pings = await sql`SELECT payload->>'op' AS op FROM realtime.pings ORDER BY 1`;
    expect(pings.map((row) => row.op)).toEqual(['DELETE', 'UPDATE', 'UPDATE']);
    expect(
      await sql`SELECT count(*)::int AS count FROM realtime.pings WHERE payload <> jsonb_build_object('op', payload->>'op')`,
    ).toEqual([{ count: 0 }]);
  });
  it('sends no ping for an UPDATE that only restamps search_indexed_at', async () => {
    const message = await arrive();
    await sql`TRUNCATE realtime.pings`;
    await sql`UPDATE messages SET search_indexed_at = now() WHERE id = ${message.id}`;
    expect(await sql`SELECT count(*)::int AS count FROM realtime.pings`).toEqual([{ count: 0 }]);
    await sql`UPDATE messages SET search_indexed_at = now(), is_unread = false WHERE id = ${message.id}`;
    expect(await sql`SELECT count(*)::int AS count FROM realtime.pings`).toEqual([{ count: 1 }]);
  });
  it('drops the unused search columns, trigram indexes, and leaves the resolver inlinable', async () => {
    const [state] = await sql`SELECT
      (SELECT count(*)::int FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('messages', 'documents')
          AND column_name = 'search') AS search_columns,
      (SELECT count(*)::int FROM pg_extension WHERE extname = 'pg_trgm') AS trgm,
      to_regclass('public.documents_user_updated_idx') IS NULL AS prefix_index_gone,
      to_regclass('public.document_files_folder_id_idx') IS NOT NULL AS folder_index,
      (SELECT proconfig IS NULL FROM pg_proc
        WHERE oid = 'public.effective_sender_decision(uuid, text)'::regprocedure) AS inlinable`;
    expect(state).toEqual({
      search_columns: 0,
      trgm: 0,
      prefix_index_gone: true,
      folder_index: true,
      inlinable: true,
    });
  });
  it('pings for a body change alongside an indexing stamp, but skips stamp-only writes', async () => {
    const message = await arrive();
    await sql`TRUNCATE realtime.pings`;
    await sql`UPDATE messages SET search_indexed_at = now() WHERE id = ${message.id}`;
    expect(await sql`SELECT * FROM realtime.pings`).toHaveLength(0);
    await sql`UPDATE messages SET body_text = repeat('large body', 10000), search_indexed_at = now() + interval '1 second' WHERE id = ${message.id}`;
    expect(await sql`SELECT * FROM realtime.pings`).toHaveLength(1);
    expect((await sql`SELECT private FROM realtime.pings`)[0].private).toBe(true);
    await sql`TRUNCATE realtime.pings`;
    await sql`UPDATE messages SET body_html = '<b>changed</b>', search_indexed_at = now() + interval '2 seconds' WHERE id = ${message.id}`;
    expect(await sql`SELECT * FROM realtime.pings`).toHaveLength(1);
    expect((await sql`SELECT private FROM realtime.pings`)[0].private).toBe(true);
  });
  it('keeps new decision data private from browser roles', async () => {
    const [privacy] = await sql`SELECT relrowsecurity AS rls,
      has_table_privilege('anon', 'public.sender_decisions', 'SELECT') AS anon_read,
      has_table_privilege('authenticated', 'public.sender_decisions', 'INSERT') AS browser_write
      FROM pg_class WHERE oid = 'public.sender_decisions'::regclass`;
    expect(privacy).toEqual({ rls: true, anon_read: false, browser_write: false });
    const [resolver] = await sql`SELECT
      has_function_privilege('anon', 'public.effective_sender_decision(uuid, text)', 'EXECUTE') AS anon,
      has_function_privilege('authenticated', 'public.effective_sender_decision(uuid, text)', 'EXECUTE') AS browser`;
    expect(resolver).toEqual({ anon: false, browser: false });
  });
});
