import { del, list } from '@vercel/blob';
import { createSql, endSql } from '../../../shared/db.js';

const BATCH_SIZE = 50;
const IMAGE_GRACE_HOURS = 24;
const IMAGE_PATH =
  /^documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[A-Za-z0-9._-]+$/;

/**
 * Persist intent before uploading bytes, so even a crash between put and the
 * metadata insert leaves a retryable cleanup pointer. Deletion triggers bring
 * an existing job forward when a registered object is removed.
 * @param {import('postgres').Sql | import('postgres').TransactionSql} sql
 * @param {'r2' | 'blob'} storage @param {string} key @param {number} [delayHours]
 */
export async function queueObjectCleanup(sql, storage, key, delayHours = 0) {
  await sql`
    INSERT INTO object_cleanup_jobs (storage, object_key, available_at)
    VALUES (${storage}, ${key}, now() + ${delayHours} * interval '1 hour')
    ON CONFLICT (storage, object_key) DO NOTHING
  `;
}

/**
 * Register before Blob put, with a deterministic UUID pathname. A failed put
 * can therefore be collected just like an image abandoned before saving.
 * @param {import('postgres').Sql} sql @param {string} userId @param {string} pathname
 */
export async function registerDocumentImage(sql, userId, pathname) {
  await sql`
    INSERT INTO document_images (pathname, user_id) VALUES (${pathname}, ${userId})
  `;
}

/**
 * Inventory one bounded page per tick, including old uploads which predate the
 * registry. Starting a new grace period on discovery protects an open editor.
 * The durable cursor makes later pages reachable across worker restarts.
 * @param {import('postgres').Sql} sql
 * @param {string} token
 * @param {typeof list} [listBlobs]
 */
export async function inventoryDocumentImages(sql, token, listBlobs = list) {
  const [state] = await sql`
    SELECT cursor FROM object_cleanup_cursors WHERE name = 'document-images'
  `;
  const page = await listBlobs({
    token,
    prefix: 'documents/',
    limit: 100,
    cursor: state?.cursor ?? undefined,
  });
  for (const blob of page.blobs) {
    const match = IMAGE_PATH.exec(blob.pathname);
    if (!match) continue;
    await sql`
      INSERT INTO document_images (pathname, user_id, created_at)
      VALUES (${blob.pathname}, ${match[1]}, ${blob.uploadedAt})
      ON CONFLICT (pathname) DO NOTHING
    `;
  }
  await sql`
    INSERT INTO object_cleanup_cursors (name, cursor)
    VALUES ('document-images', ${page.hasMore ? page.cursor : null})
    ON CONFLICT (name) DO UPDATE SET cursor = EXCLUDED.cursor
  `;
}

/**
 * Reference changes and this final GC decision use the same per-owner lock.
 * Once deleting_at is committed, a stale save must re-upload rather than
 * racing deletion. Documents and templates share the same reference set.
 * @param {import('postgres').Sql} sql
 */
export async function queueUnreferencedImages(sql) {
  const candidates = await sql`
    SELECT pathname, user_id FROM document_images
    WHERE deleting_at IS NULL
      AND unreferenced_at < now() - ${IMAGE_GRACE_HOURS} * interval '1 hour'
    ORDER BY unreferenced_at LIMIT ${BATCH_SIZE}
  `;
  for (const candidate of candidates) {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'document-images:' + candidate.user_id}, 0))`;
      const [image] = await tx`
        UPDATE document_images i SET deleting_at = now()
        WHERE pathname = ${candidate.pathname} AND deleting_at IS NULL
          AND unreferenced_at < now() - ${IMAGE_GRACE_HOURS} * interval '1 hour'
          AND NOT EXISTS (SELECT 1 FROM document_image_references r WHERE r.pathname = i.pathname)
        RETURNING pathname
      `;
      if (image) await queueObjectCleanup(tx, 'blob', image.pathname);
    });
  }
}

/**
 * @param {import('postgres').TransactionSql} tx
 * @param {{storage: string, object_key: string}} job
 * @param {boolean} deliveryLedgerExists
 */
async function hasReferences(tx, job, deliveryLedgerExists) {
  if (job.storage === 'r2') {
    const [row] = await tx`
      SELECT EXISTS (SELECT 1 FROM document_files WHERE object_key = ${job.object_key})
        OR EXISTS (SELECT 1 FROM task_comments WHERE object_key = ${job.object_key}) AS live
    `;
    return Boolean(row?.live);
  }
  const [row] = await tx`
    SELECT EXISTS (SELECT 1 FROM attachments WHERE blob_url = ${job.object_key})
      OR EXISTS (SELECT 1 FROM outbound_attachments WHERE blob_url = ${job.object_key})
      OR EXISTS (SELECT 1 FROM document_image_references WHERE pathname = ${job.object_key}) AS live
  `;
  if (row?.live) return true;
  if (!deliveryLedgerExists) return false;
  const [delivery] = await tx`
    SELECT EXISTS (
      SELECT 1 FROM outbound_deliveries d
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.copy_payload->'attachments', '[]'::jsonb)) a
      WHERE d.status IN ('pending', 'sending', 'accepted', 'uncertain')
        AND a->>'blob_url' = ${job.object_key}
    ) AS live
  `;
  return Boolean(delivery?.live);
}

/** @param {unknown} error */
function isMissingObject(error) {
  return error instanceof Error && error.name === 'BlobNotFoundError';
}

/**
 * Claims are bounded and expire after a worker crash. External deletion is
 * idempotent; a lost acknowledgement can safely repeat it. Keep the pointer
 * after failure and retry with capped exponential backoff.
 *
 * @param {import('postgres').Sql} sql
 * @param {{FILES?: R2Bucket, BLOB_READ_WRITE_TOKEN?: string}} env
 * @param {{deleteBlob?: typeof del, report?: (error: unknown) => void}} [deps]
 */
export async function processObjectCleanup(sql, env, deps = {}) {
  const lease = crypto.randomUUID();
  const jobs = await sql`
    WITH due AS (
      SELECT storage, object_key FROM object_cleanup_jobs
      WHERE deleted_at IS NULL AND available_at <= now()
        AND (lease_expires_at IS NULL OR lease_expires_at < now())
      ORDER BY available_at LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
    )
    UPDATE object_cleanup_jobs j SET lease_token = ${lease},
      lease_expires_at = now() + interval '5 minutes', attempts = attempts + 1
    FROM due WHERE j.storage = due.storage AND j.object_key = due.object_key
    RETURNING j.storage, j.object_key, j.attempts
  `;
  if (!jobs.length) return { processed: 0, failed: 0, retained: 0 };
  const [schema] =
    await sql`SELECT to_regclass('public.outbound_deliveries') IS NOT NULL AS available`;
  const summary = { processed: 0, failed: 0, retained: 0 };
  for (const job of jobs) {
    try {
      const ready = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'object-cleanup:' + job.storage + ':' + job.object_key}, 0))`;
        const [claimed] = await tx`
          SELECT object_key FROM object_cleanup_jobs
          WHERE storage = ${job.storage} AND object_key = ${job.object_key}
            AND lease_token = ${lease} AND lease_expires_at > now() AND deleted_at IS NULL
          FOR UPDATE
        `;
        if (!claimed) return false;
        if (
          await hasReferences(
            tx,
            { storage: job.storage, object_key: job.object_key },
            Boolean(schema?.available),
          )
        ) {
          // A snapshot in an unresolved delivery may outlive its source row;
          // retain that job until the snapshot is reconciled or rejected.
          await tx`
            UPDATE object_cleanup_jobs SET available_at = now() + interval '1 day',
              lease_token = NULL, lease_expires_at = NULL
            WHERE storage = ${job.storage} AND object_key = ${job.object_key} AND lease_token = ${lease}
          `;
          summary.retained++;
          return false;
        }
        await tx`
          UPDATE object_cleanup_jobs SET delete_started_at = COALESCE(delete_started_at, now())
          WHERE storage = ${job.storage} AND object_key = ${job.object_key} AND lease_token = ${lease}
        `;
        return true;
      });
      if (!ready) continue;
      if (job.storage === 'r2') {
        if (!env.FILES) throw new Error('R2 cleanup storage is not configured');
        await env.FILES.delete(job.object_key);
      } else {
        if (!env.BLOB_READ_WRITE_TOKEN) throw new Error('Blob cleanup storage is not configured');
        try {
          await (deps.deleteBlob ?? del)(job.object_key, { token: env.BLOB_READ_WRITE_TOKEN });
        } catch (error) {
          if (!isMissingObject(error)) throw error;
        }
      }
      await sql.begin(async (tx) => {
        const [completed] = await tx`
          UPDATE object_cleanup_jobs SET deleted_at = now(), lease_token = NULL, lease_expires_at = NULL
          WHERE storage = ${job.storage} AND object_key = ${job.object_key} AND lease_token = ${lease}
          RETURNING object_key
        `;
        if (completed && job.storage === 'blob') {
          await tx`UPDATE document_images SET deleted_at = now() WHERE pathname = ${job.object_key}`;
        }
      });
      summary.processed++;
    } catch (error) {
      const delaySeconds = Math.min(24 * 60 * 60, 60 * 2 ** Math.min(Number(job.attempts), 10));
      await sql`
        UPDATE object_cleanup_jobs SET available_at = now() + ${delaySeconds} * interval '1 second',
          lease_token = NULL, lease_expires_at = NULL
        WHERE storage = ${job.storage} AND object_key = ${job.object_key} AND lease_token = ${lease}
      `;
      summary.failed++;
      deps.report?.(error);
    }
  }
  return summary;
}

/**
 * @param {{HYPERDRIVE: {connectionString: string}, FILES?: R2Bucket, BLOB_READ_WRITE_TOKEN?: string}} env
 * @param {(error: unknown) => void} report
 */
export async function runObjectCleanup(env, report) {
  const sql = createSql(env.HYPERDRIVE.connectionString);
  try {
    // A Blob inventory outage must not prevent already-queued R2 deletions.
    if (env.BLOB_READ_WRITE_TOKEN) {
      try {
        await inventoryDocumentImages(sql, env.BLOB_READ_WRITE_TOKEN);
      } catch (error) {
        report(error);
      }
    }
    await queueUnreferencedImages(sql);
    const summary = await processObjectCleanup(sql, env, { report });
    const [backlog] = await sql`
      SELECT count(*)::integer AS pending,
        COALESCE(extract(epoch FROM now() - min(created_at)), 0)::integer AS oldest_seconds
      FROM object_cleanup_jobs WHERE deleted_at IS NULL
    `;
    console.log(JSON.stringify({ event: 'object_cleanup', ...summary, ...backlog }));
  } finally {
    await endSql(sql);
  }
}
