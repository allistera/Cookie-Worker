// Uploaded files in the Documents tree. Metadata lives in document_files;
// bytes live in the private R2 bucket bound as FILES, keyed by
// <user_id>/<uuid> so a key never carries a client-supplied name. Bytes only
// ever leave through getFileContent, which checks ownership first.

import { cleanText, fetchOwnedFolder } from './documents.js';
import { validId } from '../../../shared/pagination.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
// Multipart framing around the file itself; a declared body past this is
// refused before a byte is read.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 255;
const UPLOAD_RATE_LIMIT = { limit: 60, windowMs: 60_000 };
const FALLBACK_TYPE = 'application/octet-stream';
// The only types ever served inline: the sniffed set, nothing the client says.
const INLINE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

/**
 * @param {ArrayBuffer} buffer
 * @returns {string | null}
 */
export function sniffFileType(buffer) {
  const b = new Uint8Array(buffer);
  const starts = (/** @type {number[]} */ bytes) => bytes.every((v, i) => b[i] === v);
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (
    b.length >= 12 &&
    starts([0x52, 0x49, 0x46, 0x46]) &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * RFC 6266 disposition with an ASCII fallback and an RFC 5987 UTF-8 name.
 * @param {string} name @param {boolean} inline
 */
export function contentDisposition(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** @param {string} type */
function cleanMimeType(type) {
  const value = String(type ?? '')
    .trim()
    .toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(value) && value.length <= 127
    ? value
    : FALLBACK_TYPE;
}

/**
 * GET /files?folder=<uuid|root>
 * @param {import('postgres').Sql} sql @param {string} userId @param {URL} url
 */
export async function listFiles(sql, userId, url) {
  const folder = url.searchParams.get('folder');
  if (folder && folder !== 'root' && !validId(folder)) {
    return Response.json({ error: 'Invalid folder' }, { status: 400 });
  }
  const files =
    folder && folder !== 'root'
      ? await sql`
          SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at
          FROM document_files
          WHERE user_id = ${userId} AND folder_id = ${folder}
          ORDER BY created_at DESC
        `
      : await sql`
          SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at
          FROM document_files
          WHERE user_id = ${userId} AND folder_id IS NULL
          ORDER BY created_at DESC
        `;
  return Response.json({ files });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {string} id */
export async function getFile(sql, userId, id) {
  const [file] = await sql`
    SELECT id, folder_id, name, mime_type, size_bytes, created_at, updated_at
    FROM document_files
    WHERE id = ${id} AND user_id = ${userId}
  `;
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  return Response.json({ file });
}

/**
 * POST /files — multipart with `file` and optional `folder`. The object is
 * written first; a failed row insert removes it again so nothing leaks.
 *
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{FILES?: R2Bucket}} env
 * @param {{allowRequest: (sql: import('postgres').Sql, userId: string, scope: string, policy: {limit: number, windowMs: number}) => Promise<boolean>}} deps
 */
export async function uploadFile(request, sql, userId, env, deps) {
  if (!env.FILES) {
    return Response.json({ error: 'File storage is not configured' }, { status: 503 });
  }
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) {
    return Response.json({ error: 'File is larger than 25 MB' }, { status: 413 });
  }
  if (!(await deps.allowRequest(sql, userId, 'file-upload', UPLOAD_RATE_LIMIT))) {
    return Response.json({ error: 'Too many uploads, slow down' }, { status: 429 });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'Content-Type must be multipart/form-data' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'No file provided' }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return Response.json({ error: 'File is larger than 25 MB' }, { status: 413 });
  }
  const folderField = form.get('folder');
  const folderId = typeof folderField === 'string' && folderField ? folderField : null;
  if (folderId !== null) {
    if (!validId(folderId)) return Response.json({ error: 'Invalid folder' }, { status: 400 });
    const [owned] = await fetchOwnedFolder(sql, userId, folderId);
    if (!owned) return Response.json({ error: 'Folder not found' }, { status: 404 });
  }

  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return Response.json({ error: 'File is larger than 25 MB' }, { status: 413 });
  }
  const name = cleanText(file.name, MAX_NAME_LENGTH) || 'Untitled';
  const mimeType = sniffFileType(bytes) ?? cleanMimeType(file.type);
  const objectKey = `${userId}/${crypto.randomUUID()}`;

  await env.FILES.put(objectKey, bytes, { httpMetadata: { contentType: mimeType } });
  try {
    const [row] = await sql`
      INSERT INTO document_files (user_id, folder_id, name, mime_type, size_bytes, object_key)
      VALUES (${userId}, ${folderId}, ${name}, ${mimeType}, ${bytes.byteLength}, ${objectKey})
      RETURNING id, folder_id, name, mime_type, size_bytes, created_at, updated_at
    `;
    console.log(
      JSON.stringify({ event: 'file_uploaded', file_id: row.id, size: bytes.byteLength }),
    );
    return Response.json({ file: row }, { status: 201 });
  } catch (error) {
    await env.FILES.delete(objectKey).catch(() => undefined);
    console.log(
      JSON.stringify({
        event: 'file_upload_rejected',
        message: /** @type {Error} */ (error).message,
      }),
    );
    return Response.json({ error: 'Failed to store the file' }, { status: 500 });
  }
}

/**
 * GET /files/:id/content — the only way bytes leave the bucket.
 * @param {import('postgres').Sql} sql @param {string} userId @param {string} id
 * @param {{FILES?: R2Bucket}} env
 */
export async function getFileContent(sql, userId, id, env) {
  if (!env.FILES) {
    return Response.json({ error: 'File storage is not configured' }, { status: 503 });
  }
  const [file] = await sql`
    SELECT name, mime_type, object_key FROM document_files
    WHERE id = ${id} AND user_id = ${userId}
  `;
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  const object = await env.FILES.get(file.object_key);
  if (!object) {
    console.log(JSON.stringify({ event: 'file_object_missing', file_id: id }));
    return Response.json({ error: 'File not found' }, { status: 404 });
  }
  const mimeType = file.mime_type || FALLBACK_TYPE;
  return new Response(object.body, {
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(object.size),
      'Content-Disposition': contentDisposition(file.name, INLINE_TYPES.has(mimeType)),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * PATCH /files/:id — { name?, folder? }
 * @param {import('postgres').Sql} sql @param {string} userId @param {string} id @param {any} body
 */
export async function updateFile(sql, userId, id, body) {
  /** @type {{name?: string, folder_id?: string | null}} */
  const updates = {};
  if (body?.name !== undefined) {
    const name = cleanText(body.name, MAX_NAME_LENGTH);
    if (!name) return Response.json({ error: 'Name is required' }, { status: 400 });
    updates.name = name;
  }
  if (body && Object.hasOwn(body, 'folder')) {
    if (body.folder === null) {
      updates.folder_id = null;
    } else {
      if (!validId(body.folder)) return Response.json({ error: 'Invalid folder' }, { status: 400 });
      const [owned] = await fetchOwnedFolder(sql, userId, body.folder);
      if (!owned) return Response.json({ error: 'Folder not found' }, { status: 404 });
      updates.folder_id = body.folder;
    }
  }
  if (!Object.keys(updates).length) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 });
  }
  const [file] = await sql`
    UPDATE document_files
    SET ${sql(updates)}, updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id, folder_id, name, mime_type, size_bytes, created_at, updated_at
  `;
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  return Response.json({ file });
}

/**
 * DELETE /files/:id — row first, then the object. The row is the source of
 * truth; a leaked object is reported, not surfaced.
 *
 * @param {import('postgres').Sql} sql @param {string} userId @param {string} id
 * @param {{FILES?: R2Bucket}} env
 * @param {{report?: (operation: string, error: unknown, extra: Record<string, unknown>) => void}} [deps]
 */
export async function deleteFile(sql, userId, id, env, deps = {}) {
  const [file] = await sql`
    DELETE FROM document_files
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING object_key
  `;
  if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
  try {
    await env.FILES?.delete(file.object_key);
  } catch (error) {
    console.log(JSON.stringify({ event: 'file_object_delete_failed', file_id: id }));
    deps.report?.('file_object_delete', error, { file_id: id });
  }
  return new Response(null, { status: 204 });
}
