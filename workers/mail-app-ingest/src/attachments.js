import { del, put } from '@vercel/blob';

const encoder = new TextEncoder();
const UPLOAD_CONCURRENCY = 4;

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

  const workers = Array.from(
    { length: Math.min(UPLOAD_CONCURRENCY, attachments.length) },
    async () => {
      while (nextIndex < attachments.length) {
        const index = nextIndex;
        nextIndex += 1;
        const attachment = attachments[index];
        try {
          if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
          const pathname = await attachmentBlobPath(messageId, index, deliveryId);
          const blob = await putBlob(pathname, attachment.content, {
            access: 'private',
            token,
            contentType: attachment.mime_type || 'application/octet-stream',
            addRandomSuffix: false,
            allowOverwrite: false,
            multipart: attachment.size > 4 * 1024 * 1024,
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

  return { attachments: stored, failures: failures.sort((a, b) => a.index - b.index) };
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
