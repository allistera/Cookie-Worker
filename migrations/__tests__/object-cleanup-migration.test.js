import { readFile } from 'node:fs/promises';
import process from 'node:process';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.OBJECT_CLEANUP_TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl)
  throw new Error('CI must provide the object cleanup test database');
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/cookie_object_cleanup_test'
  ) {
    throw new Error(
      'Object cleanup tests require the isolated localhost cookie_object_cleanup_test database',
    );
  }
}
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PATH = `documents/${USER}/existing-image-XYZ.png`;
const IMAGE_URL = `https://store.private.blob.vercel-storage.com/${PATH}`;
const blocks = [{ type: 'image', data: { file: { url: IMAGE_URL }, caption: '' } }];

describe.skipIf(!databaseUrl)(
  '0103/0104 object lifecycle and delivery migration on PostgreSQL',
  () => {
    let sql;
    let backfill;
    let legacyDeliveries;

    beforeAll(async () => {
      sql = postgres(databaseUrl, { max: 2 });
      await sql.unsafe(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, blocks jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE document_templates (LIKE documents INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
      ALTER TABLE document_templates ADD PRIMARY KEY (id),
        ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      CREATE TABLE document_files (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, object_key text NOT NULL UNIQUE);
      CREATE TABLE task_comments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, object_key text UNIQUE);
      CREATE TABLE attachments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, blob_url text NOT NULL);
      CREATE TABLE outbound_attachments (LIKE attachments INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
      ALTER TABLE outbound_attachments ADD PRIMARY KEY (id),
        ADD FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE scheduled_sends (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label text NOT NULL, status text NOT NULL, attempts integer NOT NULL DEFAULT 0,
        claimed_at timestamptz, last_error text,
        CONSTRAINT scheduled_sends_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed')));
    `);
      await sql`INSERT INTO users VALUES (${USER})`;
      await sql`INSERT INTO documents (user_id, blocks) VALUES (${USER}, ${sql.json(blocks)})`;
      await sql`INSERT INTO document_templates (user_id, blocks) VALUES (${USER}, ${sql.json(blocks)})`;
      const migration = await readFile(
        new URL('../0103_durable_object_cleanup.sql', import.meta.url),
        'utf8',
      );
      await sql.begin((tx) => tx.unsafe(migration.replace(/^(BEGIN|COMMIT);[ \t]*$/gm, '')));
      await sql`INSERT INTO scheduled_sends (user_id, label, status, attempts) VALUES
      (${USER}, 'fresh-pending', 'pending', 0),
      (${USER}, 'attempted-pending', 'pending', 1),
      (${USER}, 'leased', 'sending', 0),
      (${USER}, 'unattempted-failed', 'failed', 0),
      (${USER}, 'exhausted-failed', 'failed', 5),
      (${USER}, 'confirmed-sent', 'sent', 1)`;
      const deliveryMigration = await readFile(
        new URL('../0104_outbound_delivery_reconciliation.sql', import.meta.url),
        'utf8',
      );
      await sql.begin((tx) =>
        tx.unsafe(deliveryMigration.replace(/^(BEGIN|COMMIT);[ \t]*$/gm, '')),
      );
      legacyDeliveries = await sql`SELECT label, status FROM scheduled_sends ORDER BY label`;
      backfill = {
        images: await sql`SELECT pathname, unreferenced_at FROM document_images`,
        refs: await sql`SELECT source_kind, pathname FROM document_image_references ORDER BY source_kind`,
      };
    });

    beforeEach(async () => {
      await sql`TRUNCATE users, object_cleanup_jobs, document_images, document_image_references, object_cleanup_cursors CASCADE`;
      await sql`INSERT INTO users VALUES (${USER}), (${OTHER})`;
    });

    afterAll(async () => {
      await sql?.end();
    });

    async function document() {
      const [row] =
        await sql`INSERT INTO documents (user_id, blocks) VALUES (${USER}, ${sql.json(blocks)}) RETURNING id`;
      return row.id;
    }

    it('requires confirmation for every legacy ambiguous delivery, including exhausted failures', () => {
      expect(legacyDeliveries).toEqual([
        { label: 'attempted-pending', status: 'uncertain' },
        { label: 'confirmed-sent', status: 'sent' },
        { label: 'exhausted-failed', status: 'uncertain' },
        { label: 'fresh-pending', status: 'pending' },
        { label: 'leased', status: 'uncertain' },
        { label: 'unattempted-failed', status: 'failed' },
      ]);
    });

    it('backfills a shared legacy image without duplicating the registry', () => {
      expect(backfill.images).toEqual([{ pathname: PATH, unreferenced_at: null }]);
      expect(backfill.refs).toEqual([
        { source_kind: 'document', pathname: PATH },
        { source_kind: 'template', pathname: PATH },
      ]);
    });

    it('retains an image until its last document and template reference is gone', async () => {
      const first = await document();
      const second = await document();
      await sql`INSERT INTO document_templates (user_id, blocks) VALUES (${USER}, ${sql.json(blocks)})`;
      await sql`DELETE FROM documents WHERE id = ${first}`;
      await sql`UPDATE documents SET blocks = '[]'::jsonb WHERE id = ${second}`;
      expect(
        (await sql`SELECT unreferenced_at FROM document_images`)[0].unreferenced_at,
      ).toBeNull();
      await sql`DELETE FROM document_templates`;
      expect(await sql`SELECT pathname FROM document_image_references`).toHaveLength(0);
      expect(
        (await sql`SELECT unreferenced_at FROM document_images`)[0].unreferenced_at,
      ).toBeInstanceOf(Date);
    });

    it('rolls reference changes back with the document write', async () => {
      const id = await document();
      await expect(
        sql.begin(async (tx) => {
          await tx`UPDATE documents SET blocks = '[]'::jsonb WHERE id = ${id}`;
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await sql`SELECT pathname FROM document_image_references`).toEqual([
        { pathname: PATH },
      ]);
      expect(
        (await sql`SELECT unreferenced_at FROM document_images`)[0].unreferenced_at,
      ).toBeNull();
    });

    it('queues every deleted storage pointer even when its owner cascades away', async () => {
      await sql`INSERT INTO document_files (user_id, object_key) VALUES (${USER}, 'file-key')`;
      await sql`INSERT INTO task_comments (user_id, object_key) VALUES (${USER}, 'comment-key')`;
      await sql`INSERT INTO attachments (user_id, blob_url) VALUES (${USER}, 'https://store/mail')`;
      await sql`INSERT INTO outbound_attachments (user_id, blob_url) VALUES (${USER}, 'https://store/upload')`;
      await document();
      await sql`DELETE FROM users WHERE id = ${USER}`;
      const jobs =
        await sql`SELECT storage, object_key FROM object_cleanup_jobs ORDER BY object_key`;
      expect(jobs).toEqual([
        { storage: 'r2', object_key: 'comment-key' },
        { storage: 'r2', object_key: 'file-key' },
        { storage: 'blob', object_key: 'https://store/mail' },
        { storage: 'blob', object_key: 'https://store/upload' },
      ]);
      expect(
        (await sql`SELECT unreferenced_at FROM document_images`)[0].unreferenced_at,
      ).toBeInstanceOf(Date);
    });

    it('queues a dropped attachment and keeps queue writes atomic with metadata', async () => {
      await sql`INSERT INTO task_comments (user_id, object_key) VALUES (${USER}, 'drop-key')`;
      await sql`UPDATE task_comments SET object_key = NULL`;
      expect(await sql`SELECT object_key FROM object_cleanup_jobs`).toEqual([
        { object_key: 'drop-key' },
      ]);
      await sql`INSERT INTO document_files (user_id, object_key) VALUES (${USER}, 'rollback-key')`;
      await expect(
        sql.begin(async (tx) => {
          await tx`DELETE FROM document_files`;
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await sql`SELECT object_key FROM object_cleanup_jobs`).toEqual([
        { object_key: 'drop-key' },
      ]);
    });

    it('refuses delayed object registration and stale image saves after deletion begins', async () => {
      await sql`INSERT INTO object_cleanup_jobs (storage, object_key, delete_started_at)
      VALUES ('blob', 'https://store/expired', now())`;
      await expect(
        sql`INSERT INTO outbound_attachments (user_id, blob_url) VALUES (${USER}, 'https://store/expired')`,
      ).rejects.toThrow('Stored object has expired');
      const id = await document();
      await sql`UPDATE documents SET blocks = '[]'::jsonb WHERE id = ${id}`;
      await sql`UPDATE document_images SET deleting_at = now() WHERE pathname = ${PATH}`;
      await expect(
        sql`UPDATE documents SET blocks = ${sql.json(blocks)} WHERE id = ${id}`,
      ).rejects.toThrow('Document image has expired');
      expect(await sql`SELECT pathname FROM document_image_references`).toHaveLength(0);
    });

    it('ignores foreign owners and noncanonical image URLs', async () => {
      await sql`INSERT INTO documents (user_id, blocks) VALUES (${OTHER}, ${sql.json(blocks)})`;
      const external = [{ data: { file: { url: 'https://example.org/image.png' } } }];
      await sql`INSERT INTO documents (user_id, blocks) VALUES (${USER}, ${sql.json(external)})`;
      expect(await sql`SELECT pathname FROM document_images`).toHaveLength(0);
    });

    it('keeps the cleanup ledger and image registry inaccessible to browser roles', async () => {
      const rows = await sql`SELECT relrowsecurity FROM pg_class
      WHERE oid IN ('object_cleanup_jobs'::regclass, 'document_images'::regclass,
        'document_image_references'::regclass, 'object_cleanup_cursors'::regclass,
        'outbound_deliveries'::regclass, 'outbound_delivery_uploads'::regclass)`;
      expect(rows.every((row) => row.relrowsecurity)).toBe(true);
      const [access] =
        await sql`SELECT has_table_privilege('anon', 'object_cleanup_jobs', 'SELECT') AS anon,
      has_table_privilege('authenticated', 'document_images', 'UPDATE') AS authenticated,
      has_table_privilege('authenticated', 'outbound_deliveries', 'SELECT') AS delivery_access`;
      expect(access).toEqual({ anon: false, authenticated: false, delivery_access: false });
    });
  },
);
