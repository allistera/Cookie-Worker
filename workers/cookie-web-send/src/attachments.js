import { queueObjectCleanup } from '../../../shared/objectCleanup.js';
import { validId } from '../../../shared/pagination.js';
import { allowRequest } from '../../../shared/rate-limit.js';
import { bodyErrorResponse, readFormBody } from '../../../shared/read-body.js';
import { MAX_OUTBOUND_ATTACHMENT_BYTES } from './outbound.js';

// Composer uploads for both clients. The iOS app and Cookie-Web's browser
// each post the file here and get back the same `outbound_attachments` row,
// so drafts (`attachmentIds` on cookie-web-drafts) and `POST /send` consume
// every upload identically. Cookie-Web used to stream bytes to Blob under a
// client token minted by a Vercel route; rows from that era share this
// prefix, so the cleanup and ownership rules keyed on it still cover them.
const ATTACHMENT_BLOB_PREFIX = 'outbound-attachments';
// One allowance per user however the file arrives.
const UPLOAD_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
// Multipart framing around the file itself; a declared body past the file
// cap plus this is refused before a byte is read.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
// Above this the SDK splits the Blob put into parts, as mail-app-ingest does.
const MULTIPART_THRESHOLD_BYTES = 4 * 1024 * 1024;
// Until the row exists nothing references the blob; a request that dies
// between put and insert is collected after this grace.
const ORPHAN_GRACE_HOURS = 24;
const MAX_FILENAME_LENGTH = 200;
const MAX_SIZE_MB = MAX_OUTBOUND_ATTACHMENT_BYTES / 1024 / 1024;
const MIME_TYPE_RE = /^[\w.+-]+\/[\w.+-]+$/;

/**
 * The visible filename, which also becomes the provider attachment name.
 * Path separators and control characters are what make a filename
 * header-injection bait, so they go rather than being trusted.
 *
 * @param {unknown} value
 */
export function sanitizeAttachmentFilename(value) {
  const base = String(value ?? '')
    .split(/[/\\]/)
    .pop();
  const cleaned = Array.from(base ?? '', (char) => {
    const code = char.charCodeAt(0);
    return code > 0x1f && code !== 0x7f ? char : '';
  })
    .join('')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned.slice(0, MAX_FILENAME_LENGTH);
}

/**
 * A safe object key under the caller's prefix. Blob adds a random suffix, so
 * two uploads of the same name never collide.
 *
 * @param {string} userId
 * @param {string} filename
 */
export function attachmentPathname(userId, filename) {
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return `${ATTACHMENT_BLOB_PREFIX}/${userId}/${safeName || 'attachment'}`;
}

/** @param {string} value */
function contentTypeOf(value) {
  const type = value.split(';')[0].trim().toLowerCase();
  return MIME_TYPE_RE.test(type) ? type : 'application/octet-stream';
}

/**
 * POST /send/attachments — multipart/form-data with one `file` field. Stores
 * the bytes in private Blob storage under the caller's prefix and returns the
 * registered upload: `{ attachment: { id, filename, content_type, size_bytes } }`.
 * The blob url never leaves the server.
 *
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {import('./outbound.js').SendServices} services
 */
export async function uploadAttachment(request, sql, userId, services) {
  const token = services.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    return Response.json({ error: 'Attachment storage is not configured' }, { status: 503 });
  }
  const declared = Number(request.headers.get('Content-Length'));
  if (
    Number.isFinite(declared) &&
    declared > MAX_OUTBOUND_ATTACHMENT_BYTES + MULTIPART_OVERHEAD_BYTES
  ) {
    return Response.json({ error: `Attachments are limited to ${MAX_SIZE_MB}MB` }, { status: 413 });
  }
  if (!(await allowRequest(sql, userId, 'attachment-upload', UPLOAD_RATE_LIMIT))) {
    return Response.json({ error: 'Too many attachment uploads, slow down' }, { status: 429 });
  }

  let form;
  try {
    form = await readFormBody(request, {
      maxBytes: MAX_OUTBOUND_ATTACHMENT_BYTES + MULTIPART_OVERHEAD_BYTES,
      fields: ['file'],
    });
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      Response.json({ error: 'Invalid multipart body' }, { status: 400 })
    );
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'A file field is required' }, { status: 400 });
  }
  if (file.size === 0) return Response.json({ error: 'That file is empty' }, { status: 400 });
  if (file.size > MAX_OUTBOUND_ATTACHMENT_BYTES) {
    return Response.json({ error: `Attachments are limited to ${MAX_SIZE_MB}MB` }, { status: 413 });
  }

  const bytes = await file.arrayBuffer();
  const filename = sanitizeAttachmentFilename(file.name);
  const contentType = contentTypeOf(file.type);
  const blob = await services.putBlob(attachmentPathname(userId, filename), bytes, {
    access: 'private',
    token,
    contentType,
    addRandomSuffix: true,
    allowOverwrite: false,
    multipart: bytes.byteLength > MULTIPART_THRESHOLD_BYTES,
  });

  // The pointer goes in before the row so a request that dies between the two
  // still ends in deletion; the row's existence is what later keeps the sweep
  // away. A failure seen here removes the blob at once instead, and a pointer
  // already recorded for it finds nothing left to delete.
  let row;
  try {
    await queueObjectCleanup(sql, 'blob', blob.url, ORPHAN_GRACE_HOURS);
    [row] = await sql`
      INSERT INTO outbound_attachments (user_id, filename, content_type, size_bytes, blob_url)
      VALUES (${userId}, ${filename}, ${contentType}, ${bytes.byteLength}, ${blob.url})
      ON CONFLICT (user_id, blob_url) DO UPDATE SET blob_url = EXCLUDED.blob_url
      RETURNING id, filename, content_type, size_bytes
    `;
  } catch (error) {
    await services.deleteBlob(blob.url).catch(() => undefined);
    throw error;
  }
  return Response.json({ attachment: row }, { status: 201 });
}

/**
 * DELETE /send/attachments/:id[?draftId=] — drops an upload the user removed
 * from the composer before sending.
 *
 * draft_attachments and scheduled_send_attachments cascade from the upload,
 * so deleting a row another draft or a queued send still uses would silently
 * strip the file from that message. Instead:
 *   - with draftId (a draft the caller owns), the upload is unlinked from that
 *     draft first, so only references elsewhere keep it alive;
 *   - the upload is deleted (204) only when no draft, no pending or sending
 *     scheduled send and no unresolved delivery references it any more;
 *   - otherwise it is kept (409) until the last reference goes, for example
 *     when the composer's own draft autosaves without it.
 * Physical deletion is queued by the row's delete trigger (Cookie-Web
 * migration 0103), which the cleanup cron drains.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 * @param {URL} url
 */
export async function deleteAttachment(sql, userId, id, url) {
  if (!validId(id)) {
    return Response.json({ error: 'A valid attachment id is required' }, { status: 400 });
  }
  const draftId = url.searchParams.get('draftId');
  if (draftId !== null && !validId(draftId)) {
    return Response.json({ error: 'draftId must be a valid id' }, { status: 400 });
  }

  // One statement, so the unlink, the reference check and the delete share a
  // snapshot. The CTEs all see the pre-statement draft_attachments, hence the
  // explicit exclusion of the rows "unlinked" removes. FOR UPDATE conflicts
  // with the key-share lock a concurrent draft save takes to reference the
  // upload, so a new reference cannot slip in between check and delete.
  const [row] = await sql`
    WITH unlinked AS (
      DELETE FROM draft_attachments da
      USING drafts d
      WHERE d.id = ${draftId}::uuid
        AND d.user_id = ${userId}
        AND da.draft_id = d.id
        AND da.outbound_attachment_id = ${id}::uuid
      RETURNING da.draft_id
    ),
    target AS (
      SELECT oa.id
      FROM outbound_attachments oa
      WHERE oa.id = ${id}::uuid AND oa.user_id = ${userId}
      FOR UPDATE
    ),
    deleted AS (
      DELETE FROM outbound_attachments oa
      USING target
      WHERE oa.id = target.id
        AND NOT EXISTS (
          SELECT 1 FROM draft_attachments da
          WHERE da.outbound_attachment_id = oa.id
            AND da.draft_id NOT IN (SELECT draft_id FROM unlinked)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM scheduled_send_attachments ssa
          JOIN scheduled_sends s ON s.id = ssa.scheduled_send_id
          WHERE ssa.outbound_attachment_id = oa.id
            AND s.status IN ('pending', 'sending')
        )
        AND NOT EXISTS (
          SELECT 1 FROM outbound_delivery_uploads du
          WHERE du.outbound_attachment_id = oa.id
        )
      RETURNING oa.id
    )
    SELECT EXISTS (SELECT 1 FROM target) AS found,
           EXISTS (SELECT 1 FROM deleted) AS deleted
  `;
  if (!row?.found) return Response.json({ error: 'Attachment not found' }, { status: 404 });
  if (!row.deleted) {
    return Response.json(
      { error: 'Attachment is still used by another draft or a pending scheduled send' },
      { status: 409 },
    );
  }
  return new Response(null, { status: 204 });
}

/**
 * Routes `/send/attachments` and `/send/attachments/:id`.
 *
 * @param {Request} request
 * @param {URL} url
 * @param {string | undefined} id The third path segment, when present.
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {import('./outbound.js').SendServices} services
 */
export function handleAttachments(request, url, id, sql, userId, services) {
  if (id === undefined) {
    if (request.method === 'POST') return uploadAttachment(request, sql, userId, services);
    return Promise.resolve(
      Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } }),
    );
  }
  if (request.method === 'DELETE') return deleteAttachment(sql, userId, id, url);
  return Promise.resolve(
    Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'DELETE' } }),
  );
}
