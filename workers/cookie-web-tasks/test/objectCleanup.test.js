import { describe, expect, it, vi } from 'vitest';
import { createMockSql } from './helpers.js';
import {
  inventoryDocumentImages,
  processObjectCleanup,
  queueUnreferencedImages,
} from '../src/objectCleanup.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PATH = `documents/${USER}/image-abc.png`;

/** @param {unknown[][]} results */
function cleanupSql(results) {
  return createMockSql(results);
}

describe('private object cleanup', () => {
  it('acknowledges R2 deletion only after storage succeeds', async () => {
    const job = { storage: 'r2', object_key: `${USER}/file`, attempts: 1 };
    const sql = cleanupSql([
      [job],
      [{ available: false }],
      [{ object_key: job.object_key }],
      [{ live: false }],
      [],
      [{ object_key: job.object_key }],
    ]);
    const remove = vi.fn().mockResolvedValue(undefined);
    const summary = await processObjectCleanup(sql, {
      FILES: /** @type {any} */ ({ delete: remove }),
    });
    expect(summary).toEqual({ processed: 1, failed: 0, retained: 0 });
    expect(remove).toHaveBeenCalledWith(job.object_key);
    const acknowledgement = sql.mock.invocationCallOrder[sql.mock.invocationCallOrder.length - 1];
    expect(acknowledgement).toBeGreaterThan(remove.mock.invocationCallOrder[0]);
    expect(sql.calls.at(-1).text).toContain('deleted_at = now()');
    expect(sql.calls[0].text).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('keeps the pointer and retries after a failed delete', async () => {
    const job = { storage: 'r2', object_key: `${USER}/file`, attempts: 3 };
    const sql = cleanupSql([
      [job],
      [{ available: false }],
      [{ object_key: job.object_key }],
      [{ live: false }],
      [],
      [],
    ]);
    const error = new Error('temporary storage outage');
    const remove = vi.fn().mockRejectedValue(error);
    const report = vi.fn();
    const summary = await processObjectCleanup(
      sql,
      { FILES: /** @type {any} */ ({ delete: remove }) },
      { report },
    );
    expect(summary.failed).toBe(1);
    expect(report).toHaveBeenCalledWith(error);
    expect(sql.calls.at(-1).text).toContain('available_at = now()');
    expect(sql.calls.at(-1).values[0]).toBe(480);
    expect(sql.calls.some((call) => call.text.includes('deleted_at = now()'))).toBe(false);
    expect(sql.calls.some((call) => call.text.includes('DELETE FROM object_cleanup_jobs'))).toBe(
      false,
    );
  });

  it('retains shared bytes and snapshots belonging to unresolved outbound delivery', async () => {
    const job = {
      storage: 'blob',
      object_key: 'https://store.private.blob.vercel-storage.com/mail/a',
      attempts: 1,
    };
    const sql = cleanupSql([
      [job],
      [{ available: true }],
      [{ object_key: job.object_key }],
      [{ live: false }],
      [{ live: true }],
      [],
    ]);
    const deleteBlob = vi.fn();
    const summary = await processObjectCleanup(
      sql,
      { BLOB_READ_WRITE_TOKEN: 'test' },
      { deleteBlob },
    );
    expect(summary).toEqual({ processed: 0, failed: 0, retained: 1 });
    expect(deleteBlob).not.toHaveBeenCalled();
    expect(sql.calls[4].text).toContain(
      "d.status IN ('pending', 'sending', 'accepted', 'uncertain')",
    );
    expect(sql.calls.at(-1).text).toContain("interval '1 day'");
  });

  it('checks ordinary file references before attempting external deletion', async () => {
    const job = { storage: 'r2', object_key: `${USER}/file`, attempts: 1 };
    const sql = cleanupSql([
      [job],
      [{ available: false }],
      [{ object_key: job.object_key }],
      [{ live: true }],
      [],
    ]);
    const remove = vi.fn();
    const summary = await processObjectCleanup(sql, {
      FILES: /** @type {any} */ ({ delete: remove }),
    });
    expect(summary.retained).toBe(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it('treats an already-missing Blob as successful and keeps the image tombstone', async () => {
    const job = { storage: 'blob', object_key: PATH, attempts: 2 };
    const sql = cleanupSql([
      [job],
      [{ available: false }],
      [{ object_key: PATH }],
      [{ live: false }],
      [],
      [{ object_key: PATH }],
      [],
    ]);
    const missing = new Error('already gone');
    missing.name = 'BlobNotFoundError';
    const deleteBlob = vi.fn().mockRejectedValue(missing);
    const summary = await processObjectCleanup(
      sql,
      { BLOB_READ_WRITE_TOKEN: 'test' },
      { deleteBlob },
    );
    expect(summary.processed).toBe(1);
    expect(sql.calls.at(-1).text).toContain('UPDATE document_images SET deleted_at');
  });

  it('leaves jobs retryable when a required storage binding is missing', async () => {
    const job = { storage: 'blob', object_key: PATH, attempts: 1 };
    const sql = cleanupSql([
      [job],
      [{ available: false }],
      [{ object_key: PATH }],
      [{ live: false }],
      [],
      [],
    ]);
    const summary = await processObjectCleanup(sql, {});
    expect(summary.failed).toBe(1);
    expect(sql.calls.at(-1).text).toContain('available_at = now()');
  });

  it('does not delete after its lease has been lost', async () => {
    const job = { storage: 'blob', object_key: PATH, attempts: 1 };
    const sql = cleanupSql([[job], [{ available: false }], []]);
    const deleteBlob = vi.fn();
    await processObjectCleanup(sql, { BLOB_READ_WRITE_TOKEN: 'test' }, { deleteBlob });
    expect(deleteBlob).not.toHaveBeenCalled();
  });
});

describe('document image collection', () => {
  it('rechecks references under the same owner lock before queuing deletion', async () => {
    const sql = createMockSql([[{ pathname: PATH, user_id: USER }], []]);
    await queueUnreferencedImages(sql);
    expect(sql.controlCalls[0].values).toContain(`document-images:${USER}`);
    expect(sql.calls[1].text).toContain('NOT EXISTS (SELECT 1 FROM document_image_references');
    expect(sql.calls.some((call) => call.text.includes('INSERT INTO object_cleanup_jobs'))).toBe(
      false,
    );
  });

  it('queues the image in the transaction which freezes new references', async () => {
    const sql = createMockSql([[{ pathname: PATH, user_id: USER }], [{ pathname: PATH }], []]);
    await queueUnreferencedImages(sql);
    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(sql.calls[1].text).toContain('deleting_at = now()');
    expect(sql.calls[2].values).toEqual(['blob', PATH, 0]);
  });

  it('uses and advances a durable cursor without registering unrelated namespaces', async () => {
    const sql = createMockSql([[{ cursor: 'previous-page' }], [], []]);
    const listBlobs = vi.fn().mockResolvedValue({
      blobs: [
        { pathname: PATH, uploadedAt: new Date('2026-01-01T00:00:00Z') },
        { pathname: 'outbound-attachments/other', uploadedAt: new Date() },
      ],
      hasMore: true,
      cursor: 'next-page',
    });
    await inventoryDocumentImages(sql, 'test', listBlobs);
    expect(listBlobs).toHaveBeenCalledWith({
      token: 'test',
      prefix: 'documents/',
      limit: 100,
      cursor: 'previous-page',
    });
    expect(sql.calls[1].values.slice(0, 2)).toEqual([PATH, USER]);
    expect(sql.calls[2].values).toEqual(['next-page']);
  });
});
