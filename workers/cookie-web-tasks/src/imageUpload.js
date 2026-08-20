// Stores a document image in Vercel Blob. Client-supplied MIME types and
// filenames are not trusted: bytes are sniffed, and the object key is a
// generated UUID. Images stay public URLs because Editor.js renders them
// as <img src> in the document; the pathname is unguessable.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UPLOAD_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

const SIGNATURES = [
  { type: 'image/jpeg', ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: 'image/gif', ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: 'image/webp', ext: 'webp', riff: true },
];

/**
 * @param {ArrayBuffer} buffer
 * @returns {{type: string, ext: string} | null}
 */
export function sniffImageType(buffer) {
  const bytes = new Uint8Array(buffer);
  for (const signature of SIGNATURES) {
    if (signature.riff) {
      if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      ) {
        return { type: signature.type, ext: signature.ext };
      }
      continue;
    }
    if (signature.bytes.every((value, index) => bytes[index] === value)) {
      return { type: signature.type, ext: signature.ext };
    }
  }
  return null;
}

/**
 * @typedef {{
 *   put: (fileName: string, fileData: ArrayBuffer, options: { access: 'public', contentType: string, token: string, addRandomSuffix?: boolean }) => Promise<{ url: string }>,
 *   allowRequest?: (sql: import('postgres').Sql, userId: string, scope: string, policy: {limit: number, windowMs: number}) => Promise<boolean>,
 *   sql?: import('postgres').Sql,
 *   userId?: string,
 * }} ImageUploadDeps
 */

/**
 * POST /tasks/image-upload — stores a document image in Vercel Blob.
 *
 * @param {Request} request
 * @param {ImageUploadDeps} deps
 * @param {string | undefined} blobToken
 */
export async function postImageUpload(request, deps, blobToken) {
  if (!blobToken) {
    return Response.json({ error: 'Image storage is not configured' }, { status: 503 });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'Content-Type must be multipart/form-data' }, { status: 400 });
  }

  const file = form.get('image');
  if (!(file instanceof File)) {
    return Response.json({ error: 'No image file provided' }, { status: 400 });
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return Response.json({ error: `Image size exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit` }, { status: 400 });
  }

  if (deps.allowRequest && deps.sql && deps.userId) {
    const allowed = await deps.allowRequest(deps.sql, deps.userId, 'image-upload', UPLOAD_RATE_LIMIT);
    if (!allowed) {
      return Response.json({ error: 'Too many uploads, slow down' }, { status: 429 });
    }
  }

  try {
    const fileData = await file.arrayBuffer();
    const sniffed = sniffImageType(fileData);
    if (!sniffed) {
      return Response.json(
        { error: 'Invalid file type. Allowed: image/jpeg, image/png, image/gif, image/webp' },
        { status: 400 },
      );
    }
    const pathname = `documents/${deps.userId || 'anon'}/${crypto.randomUUID()}.${sniffed.ext}`;
    const blob = await deps.put(pathname, fileData, {
      access: 'public',
      contentType: sniffed.type,
      token: /** @type {string} */ (blobToken),
      addRandomSuffix: true,
    });
    return Response.json({ url: blob.url });
  } catch (error) {
    console.log(JSON.stringify({ event: 'image_upload_failed', message: /** @type {Error} */ (error).message }));
    return Response.json({ error: 'Failed to upload image' }, { status: 500 });
  }
}
