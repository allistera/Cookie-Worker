import process from 'node:process';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDelivery, findDelivery } from '../src/deliveryLedger.js';
import { resumeDelivery } from '../src/outbound.js';

const databaseUrl = process.env.SCREENING_RETENTION_TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error('CI requires the disposable delivery database');
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/cookie_screening_retention_test' ||
    url.search ||
    url.hash
  )
    throw new Error('Delivery tests require the isolated loopback test database');
}
const OWNER = '11111111-1111-4111-8111-111111111111';
const UPLOAD = '22222222-2222-4222-8222-222222222222';
const payload = {
  from: 'Cookie <sender@example.com>',
  to: ['recipient@example.com'],
  subject: 'Hello',
  text: 'Body',
};
const copy = {
  recipients: payload.to,
  subject: payload.subject,
  text: payload.text,
  html: null,
  replyToMessageId: null,
  readReceiptToken: null,
  attachments: [],
};
function connect() {
  if (!databaseUrl) throw new Error('Test database is not configured');
  return postgres(databaseUrl, {
    max: 1,
    connection: { search_path: 'outbound_delivery_fixture', statement_timeout: 10000 },
  });
}
/** @param {any} [sendProvider] */
function services(
  sendProvider = vi.fn(async () => ({ status: 'sent', providerId: 'provider-1' })),
) {
  return /** @type {any} */ ({
    env: { EMAIL_FROM: payload.from },
    sendProvider,
    indexSentMessages: vi.fn(),
  });
}
// Inject only an interrupted history read; real ledger transactions still
// execute on PostgreSQL, including receipt persistence and claim locking.
function interruptedCopy(sql) {
  return new Proxy(sql, {
    apply(target, self, args) {
      if (args[0].join(' ').includes('SELECT CASE WHEN')) throw new Error('History unavailable');
      return Reflect.apply(target, self, args);
    },
  });
}

describe.skipIf(!databaseUrl)('durable outbound delivery on PostgreSQL', () => {
  /** @type {import('postgres').Sql} */
  let sql;
  beforeAll(async () => {
    sql = connect();
    // Minimal post-0104 fixture; the production functions execute their own SQL.
    await sql.unsafe(`
      CREATE SCHEMA outbound_delivery_fixture;
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE threads(id uuid PRIMARY KEY,user_id uuid,subject text,last_message_at timestamptz,message_count int DEFAULT 1);
      CREATE TABLE messages(id uuid PRIMARY KEY,thread_id uuid,user_id uuid,from_name text,from_address text,
        recipients jsonb,subject text,snippet text,body_text text,body_html text,sent_at timestamptz,
        message_id text,is_unread boolean,is_sent boolean,follow_up_at timestamptz);
      CREATE UNIQUE INDEX message_provider_id ON messages(user_id,message_id) WHERE message_id IS NOT NULL;
      CREATE TABLE attachments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),message_id uuid,filename text,content_type text,size_bytes bigint,blob_url text);
      CREATE TABLE outbound_attachments(id uuid PRIMARY KEY,user_id uuid,blob_url text);
      CREATE TABLE scheduled_sends(id uuid PRIMARY KEY,user_id uuid,status text,sent_message_id uuid,sent_at timestamptz,claimed_at timestamptz,last_error text);
      CREATE TABLE outbound_deliveries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES users(id) ON DELETE CASCADE,
        source_key text NOT NULL,request_id text,provider_payload jsonb NOT NULL,copy_payload jsonb NOT NULL,status text DEFAULT 'pending',
        attempts int DEFAULT 0,first_attempt_at timestamptz,retry_until timestamptz,claimed_at timestamptz,claim_token uuid,
        provider_id text,accepted_at timestamptz,sent_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
        last_error text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),UNIQUE(user_id,source_key));
      CREATE UNIQUE INDEX delivery_request ON outbound_deliveries(user_id,request_id) WHERE request_id IS NOT NULL;
      CREATE TABLE outbound_delivery_uploads(delivery_id uuid REFERENCES outbound_deliveries(id) ON DELETE CASCADE,
        outbound_attachment_id uuid REFERENCES outbound_attachments(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
        PRIMARY KEY(delivery_id,outbound_attachment_id));
    `);
  });
  beforeEach(async () => {
    await sql.unsafe(
      'TRUNCATE users, threads, messages, attachments, outbound_attachments, scheduled_sends, outbound_deliveries, outbound_delivery_uploads CASCADE',
    );
    await sql`INSERT INTO users(id) VALUES (${OWNER})`;
  });
  afterAll(async () => {
    if (sql) {
      await sql.unsafe('DROP SCHEMA outbound_delivery_fixture CASCADE');
      await sql.end();
    }
  });

  it('serializes concurrent intents and dispatches one provider request', async () => {
    const other = connect();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const send = vi.fn(async () => {
      entered.resolve(undefined);
      await release.promise;
      return { status: 'sent', providerId: 'provider-1' };
    });
    try {
      const [first, second] = await Promise.all([
        createDelivery(sql, OWNER, 'immediate-send/one', payload, copy, 'client-1'),
        createDelivery(other, OWNER, 'immediate-send/one', payload, copy, 'client-1'),
      ]);
      expect(first.id).toBe(second.id);
      const sending = resumeDelivery(sql, first, services(send));
      await entered.promise;
      await expect(resumeDelivery(other, second, services(send))).rejects.toMatchObject({
        code: 'DELIVERY_PENDING',
      });
      release.resolve(undefined);
      const result = await sending;
      expect(result.sentCopyPending).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await sql`SELECT id FROM messages`).toHaveLength(1);
    } finally {
      release.resolve(undefined);
      await other.end();
    }
  });

  it('repairs an accepted sent copy beyond 24 hours without contacting the provider', async () => {
    const row = await createDelivery(sql, OWNER, 'immediate-send/two', payload, copy, 'client-2');
    const svc = services();
    const first = await resumeDelivery(interruptedCopy(sql), row, svc);
    expect(first).toMatchObject({ resendId: 'provider-1', sentCopyPending: true });
    await sql`UPDATE outbound_deliveries SET first_attempt_at = now() - interval '26 hours',
      retry_until = now() - interval '3 hours' WHERE id = ${row.id}`;
    const repaired = await resumeDelivery(sql, row, svc);
    expect(repaired.sentCopyPending).toBe(false);
    expect(svc.sendProvider).toHaveBeenCalledTimes(1);
    const [stored] =
      await sql`SELECT d.status,abs(extract(epoch FROM m.sent_at - d.accepted_at)) < 0.001 AS original_time
      FROM outbound_deliveries d JOIN messages m ON m.id = d.sent_message_id`;
    expect(stored).toEqual({ status: 'complete', original_time: true });
    const [ledger] = await sql`SELECT provider_payload, copy_payload FROM outbound_deliveries`;
    expect(ledger).toEqual({ provider_payload: {}, copy_payload: { followUpAt: null } });
  });

  it('expires an ambiguous outcome using its original deadline and never sends again', async () => {
    const row = await createDelivery(
      sql,
      OWNER,
      'scheduled-send/33333333-3333-4333-8333-333333333333',
      payload,
      copy,
      null,
    );
    const svc = services(vi.fn(async () => ({ status: 'retry', providerId: null })));
    await expect(resumeDelivery(sql, row, svc)).rejects.toMatchObject({ code: 'DELIVERY_PENDING' });
    const [attempt] =
      await sql`SELECT retry_until - first_attempt_at = interval '23 hours' AS bounded FROM outbound_deliveries`;
    expect(attempt.bounded).toBe(true);
    await sql`UPDATE outbound_deliveries SET first_attempt_at = now() - interval '25 hours',
      retry_until = now() - interval '2 hours' WHERE id = ${row.id}`;
    await expect(resumeDelivery(sql, row, svc)).rejects.toMatchObject({
      code: 'DELIVERY_UNCERTAIN',
    });
    await expect(resumeDelivery(sql, row, svc)).rejects.toMatchObject({
      code: 'DELIVERY_UNCERTAIN',
    });
    expect(svc.sendProvider).toHaveBeenCalledTimes(1);
    expect((await findDelivery(sql, OWNER, row.source_key)).status).toBe('uncertain');
  });

  it('rejects reusing a client identity with changed content', async () => {
    await createDelivery(sql, OWNER, 'immediate-send/original', payload, copy, 'client-3');
    await expect(
      createDelivery(
        sql,
        OWNER,
        'immediate-send/changed',
        { ...payload, text: 'Changed' },
        copy,
        'client-3',
      ),
    ).rejects.toMatchObject({ code: 'DELIVERY_CONFLICT' });
  });

  it('protects upload metadata for unresolved deliveries', async () => {
    await sql`INSERT INTO outbound_attachments(id,user_id,blob_url) VALUES (${UPLOAD},${OWNER},'https://blob.test/file')`;
    await createDelivery(
      sql,
      OWNER,
      'immediate-send/attachment',
      payload,
      {
        ...copy,
        attachments: [{ id: UPLOAD, source: 'upload', blob_url: 'https://blob.test/file' }],
      },
      'client-4',
    );
    await expect(sql`DELETE FROM outbound_attachments WHERE id = ${UPLOAD}`).rejects.toMatchObject({
      code: '23503',
    });
  });
});
