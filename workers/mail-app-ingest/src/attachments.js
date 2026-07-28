import { put } from '@vercel/blob';

const encoder = new TextEncoder();

/**
 * A stable, sender-data-free Blob pathname makes MTA retries overwrite the
 * same private object instead of creating duplicates.
 *
 * @param {string} messageId
 * @param {number} index
 */
export async function attachmentBlobPath(messageId, index) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(messageId));
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
  const stored = [];
  const failures = [];

  for (const [index, attachment] of attachments.entries()) {
    try {
      if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not configured');
      const pathname = await attachmentBlobPath(messageId, index);
      const blob = await putBlob(pathname, attachment.content, {
        access: 'private',
        token,
        contentType: attachment.mime_type || 'application/octet-stream',
        addRandomSuffix: false,
        allowOverwrite: true,
        multipart: attachment.size > 4 * 1024 * 1024,
      });
      stored.push({ ...attachment, content: undefined, blob_url: blob.url });
    } catch (error) {
      stored.push({ ...attachment, content: undefined, blob_url: null });
      failures.push({ index, error });
    }
  }

  return { attachments: stored, failures };
}
