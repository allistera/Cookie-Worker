// Stores a document image in Cookie's private Vercel Blob store (the same
// store as mail attachments). Client-supplied MIME types and filenames are
// not trusted: bytes are sniffed, and the object key is a generated UUID
// under documents/<userId>/. The document keeps the private blob URL; the
// editor shows it through a short-lived signed link from
// GET /tasks/document-image, issued only to the image's owner.

import { privateBlobPathname } from '../../../shared/private-blob.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UPLOAD_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
// Long enough for an editing session; the editor asks for a fresh link when
// a document is opened again after it has expired.
const SIGNED_URL_TTL_MS = 60 * 60 * 1000;

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
    if (signature.bytes?.every((value, index) => bytes[index] === value)) {
      return { type: signature.type, ext: signature.ext };
    }
  }
  return null;
}

/**
 * @typedef {{
 *   put: (fileName: string, fileData: ArrayBuffer, options: { access: 'private', contentType: string, token: string, addRandomSuffix?: boolean }) => Promise<{ url: string }>,
 *   allowRequest?: (sql: import('postgres').Sql, userId: string, scope: string, policy: {limit: number, windowMs: number}) => Promise<boolean>,
 *   sql?: import('postgres').Sql,
 *   userId?: string,
 *   report?: (operation: string, error: unknown) => void,
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
    return Response.json(
      { error: `Image size exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit` },
      { status: 400 },
    );
  }

  if (deps.allowRequest && deps.sql && deps.userId) {
    const allowed = await deps.allowRequest(
      deps.sql,
      deps.userId,
      'image-upload',
      UPLOAD_RATE_LIMIT,
    );
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
      access: 'private',
      contentType: sniffed.type,
      token: /** @type {string} */ (blobToken),
      addRandomSuffix: true,
    });
    return Response.json({ url: blob.url });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'image_upload_failed',
        message: /** @type {Error} */ (error).message,
      }),
    );
    // Storage failures used to be log-only (and logs are sampled), which hid
    // a store misconfiguration; report them like other handled errors.
    deps.report?.('image_upload', error);
    return Response.json({ error: 'Failed to upload image' }, { status: 500 });
  }
}

/**
 * @typedef {{
 *   issueSignedToken: typeof import('@vercel/blob').issueSignedToken,
 *   presignUrl: typeof import('@vercel/blob').presignUrl,
 *   token: string | undefined,
 *   now?: () => number,
 * }} ImageSigner
 */

/**
 * GET /tasks/document-image?url=<private blob URL> — a short-lived signed
 * link for one of the caller's own document images, usable as <img src>.
 *
 * @param {URL} requestUrl
 * @param {string} userId
 * @param {ImageSigner} signer
 */
export async function getDocumentImageUrl(requestUrl, userId, signer) {
  const noStore = { 'Cache-Control': 'private, no-store' };
  if (!signer.token) {
    return Response.json(
      { error: 'Image storage is not configured' },
      { status: 503, headers: noStore },
    );
  }
  let pathname;
  try {
    pathname = privateBlobPathname(requestUrl.searchParams.get('url') ?? '');
  } catch {
    return Response.json(
      { error: 'A document image URL is required' },
      { status: 400, headers: noStore },
    );
  }
  // Only the owner's own uploads: pathnames are documents/<userId>/<uuid>...
  // A decoded ".." would still start with this prefix, so reject it outright.
  if (!pathname.startsWith(`documents/${userId}/`) || pathname.includes('..')) {
    return Response.json({ error: 'Image not found' }, { status: 404, headers: noStore });
  }
  const validUntil = (signer.now?.() ?? Date.now()) + SIGNED_URL_TTL_MS;
  const signedToken = await signer.issueSignedToken({
    pathname,
    operations: ['get'],
    validUntil,
    token: signer.token,
  });
  const { presignedUrl } = await signer.presignUrl(signedToken, {
    access: 'private',
    operation: 'get',
    pathname,
    validUntil,
  });
  return Response.json(
    { url: presignedUrl, expiresAt: new Date(validUntil).toISOString() },
    { headers: noStore },
  );
}
