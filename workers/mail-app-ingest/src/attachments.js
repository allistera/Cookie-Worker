import { del, put } from '@vercel/blob';

const encoder = new TextEncoder();
const UPLOAD_CONCURRENCY = 4;
const MULTIPART_THRESHOLD_BYTES = 4 * 1024 * 1024;
/**
 * Vercel Blob multipart uploads spend several subrequests (init, parts,
 * complete); plain puts spend one. The estimate stays conservative so the
 * whole ingest invocation keeps headroom under the platform subrequest cap
 * alongside forward(), enrichment calls, and blob cleanup.
 */
const MULTIPART_SUBREQUEST_COST = 4;
/** Hard ceiling on uploads per delivery regardless of estimated cost. */
export const MAX_ATTACHMENT_UPLOADS = 20;
/**
 * Subrequests reserved for attachment uploads. Remaining budget covers
 * forward(), AI enrichment, cleanup deletes, and platform overhead.
 */
export const UPLOAD_SUBREQUEST_BUDGET = 30;

/**
 * A sender-data-free Blob pathname. The per-delivery identifier keeps retries
 * immutable so a duplicate delivery cannot replace an existing object.
 *
 * @param {string} messageId
 * @param {number} index
 * @param {string} [deliveryId]
 */
export async function attachmentBlobPath(messageId, index, deliveryId = '') {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${messageId}\0${deliveryId}`),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `mail-attachments/${hash}/${index}`;
}

/**
 * Uploads attachment bytes to private Vercel Blob storage. Each failure is
 * isolated so the email and the other attachments can still be stored.
 *
 * Uploads are bounded by a subrequest budget: once it is exhausted (or the
 * hard upload cap is reached) remaining attachments are stored metadata-only
 * with a null blob_url. Without this cap an email with dozens of attachments
 * exhausts the platform per-invocation subrequest limit mid-upload, which
 * fails before storeEmail commits and turns every MTA retry into a
 * deterministic poison-message loop.
 *
 * @param {{filename: string | null, mime_type: string, size: number, content: ArrayBuffer}[]} attachments
 * @param {string} messageId
 * @param {string | undefined} token
 * @param {typeof put} [putBlob]
 */
export async function uploadAttachments(attachments, messageId, token, putBlob = put) {
  const stored = Array.from({ length: attachments.length });
  const failures = [];
  const deliveryId = crypto.randomUUID();
  let nextIndex = 0;
  let budget = UPLOAD_SUBREQUEST_BUDGET;
  let uploadedCount = 0;

  /**
   * Claims the next index and reserves its budget synchronously so
   * concurrent workers cannot oversubscribe the invocation's cap.
   */
  const claimNext = () => {
    if (nextIndex >= attachments.length || uploadedCount >= MAX_ATTACHMENT_UPLOADS) return null;
    const attachment = attachments[nextIndex];
    const cost = attachment.size > MULTIPART_THRESHOLD_BYTES ? MULTIPART_SUBREQUEST_COST : 1;
    if (budget < cost) return null;
    const claim = { index: nextIndex, attachment };
    nextIndex += 1;
    budget -= cost;
    uploadedCount += 1;
    return claim;
  };

  const workers = Array.from(
    { length: Math.min(UPLOAD_CONCURRENCY, attachments.length) },
    async () => {
      for (;;) {
        const claim = claimNext();
        if (!claim) break;
        const { index, attachment } = claim;
        try {
          if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
          const pathname = await attachmentBlobPath(messageId, index, deliveryId);
          const blob = await putBlob(pathname, attachment.content, {
            access: 'private',
            token,
            contentType: attachment.mime_type || 'application/octet-stream',
            addRandomSuffix: false,
            allowOverwrite: false,
            multipart: attachment.size > MULTIPART_THRESHOLD_BYTES,
          });
          stored[index] = { ...attachment, content: undefined, blob_url: blob.url };
        } catch (error) {
          stored[index] = { ...attachment, content: undefined, blob_url: null };
          failures.push({ index, error });
        }
      }
    },
  );
  await Promise.all(workers);

  let skipped = 0;
  for (let index = 0; index < attachments.length; index += 1) {
    if (stored[index] === undefined) {
      stored[index] = { ...attachments[index], content: undefined, blob_url: null };
      skipped += 1;
    }
  }

  return {
    attachments: stored,
    failures: failures.sort((a, b) => a.index - b.index),
    skipped,
  };
}

/**
 * Delete blobs uploaded by this delivery when no database row retained them.
 * Metadata-only attachments have a null URL and need no cleanup.
 *
 * @param {{blob_url?: string | null}[]} attachments
 * @param {string | undefined} token
 * @param {typeof del} [deleteBlob]
 */
export async function deleteUploadedAttachments(attachments, token, deleteBlob = del) {
  const urls = attachments.map((attachment) => attachment.blob_url).filter(Boolean);
  if (urls.length === 0) return 0;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
  await deleteBlob(/** @type {string[]} */ (urls), { token });
  return urls.length;
}
