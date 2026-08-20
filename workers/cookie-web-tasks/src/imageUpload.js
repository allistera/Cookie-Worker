// Ported from Cookie-Web's api/_lib/imageUpload.js, REDESIGNED: Cookie-Web's
// version hand-rolled a binary-string multipart/form-data parser because
// Vercel's Node runtime handed it a raw request stream. Workers' Web-standard
// Request gives us formData() natively — it does the same job correctly
// (including binary-safe file contents, which the old string-split/replace
// approach was not guaranteed to be for arbitrary bytes), so the parser is
// dropped rather than ported.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * @typedef {{ put: (fileName: string, fileData: ArrayBuffer, options: { access: 'public', contentType: string, token: string }) => Promise<{ url: string }> }} ImageUploadDeps
 */

// POST /tasks/image-upload — stores a document image in Vercel Blob.
/**
 * @param {Request} request
 * @param {ImageUploadDeps} deps
 * @param {string | undefined} blobToken
 */
export async function postImageUpload(request, deps, blobToken) {
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

  const fileType = file.type || 'image/jpeg';
  if (!ALLOWED_TYPES.includes(fileType)) {
    return Response.json({ error: `Invalid file type. Allowed: ${ALLOWED_TYPES.join(', ')}` }, { status: 400 });
  }

  try {
    const fileData = await file.arrayBuffer();
    const blob = await deps.put(file.name, fileData, {
      access: 'public',
      contentType: fileType,
      token: /** @type {string} */ (blobToken),
    });
    return Response.json({ url: blob.url });
  } catch (error) {
    console.log(JSON.stringify({ event: 'image_upload_failed', message: /** @type {Error} */ (error).message }));
    return Response.json({ error: 'Failed to upload image' }, { status: 500 });
  }
}
