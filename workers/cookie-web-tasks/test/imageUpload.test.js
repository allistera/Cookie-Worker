import { describe, expect, it, vi } from 'vitest';
import { postImageUpload } from '../src/imageUpload.js';

/** @param {{name?: string, type?: string, bytes?: number}} [opts] */
function uploadRequest({ name = 'photo.png', type = 'image/png', bytes = 10 } = {}) {
  const form = new FormData();
  form.set('image', new File([new Uint8Array(bytes)], name, { type }));
  return new Request('https://cookie-web-tasks.example/tasks/image-upload', { method: 'POST', body: form });
}

describe('postImageUpload', () => {
  it('stores the image and returns its blob URL', async () => {
    const put = vi.fn().mockResolvedValue({ url: 'https://blob.example/photo.png' });
    const response = await postImageUpload(uploadRequest(), { put }, 'blob-token');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://blob.example/photo.png' });
    expect(put).toHaveBeenCalledWith('photo.png', expect.any(ArrayBuffer), {
      access: 'public',
      contentType: 'image/png',
      token: 'blob-token',
    });
  });

  it('rejects a request with no image field', async () => {
    const put = vi.fn();
    const form = new FormData();
    form.set('other', 'x');
    const request = new Request('https://cookie-web-tasks.example/tasks/image-upload', { method: 'POST', body: form });

    const response = await postImageUpload(request, { put }, 'blob-token');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('No image file provided');
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects a non-multipart request without throwing', async () => {
    const put = vi.fn();
    const request = new Request('https://cookie-web-tasks.example/tasks/image-upload', {
      method: 'POST',
      body: 'not-multipart',
      headers: { 'Content-Type': 'text/plain' },
    });

    const response = await postImageUpload(request, { put }, 'blob-token');
    expect(response.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects an oversized image without calling Blob storage', async () => {
    const put = vi.fn();
    const response = await postImageUpload(uploadRequest({ bytes: 5 * 1024 * 1024 + 1 }), { put }, 'blob-token');

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('5MB limit');
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects an unsupported image type without calling Blob storage', async () => {
    const put = vi.fn();
    const response = await postImageUpload(uploadRequest({ type: 'image/svg+xml' }), { put }, 'blob-token');

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Invalid file type');
    expect(put).not.toHaveBeenCalled();
  });

  it('falls back to image/jpeg when the file carries no type', async () => {
    // A real multipart round-trip normalizes a typeless part to
    // application/octet-stream (there's no way to encode "no Content-Type"
    // as an empty string in the wire format), so this stubs formData()
    // directly to exercise the `file.type || 'image/jpeg'` fallback itself.
    const form = new FormData();
    form.set('image', new File([new Uint8Array(10)], 'photo.png', { type: '' }));
    const request = /** @type {any} */ ({ formData: async () => form });

    const put = vi.fn().mockResolvedValue({ url: 'https://blob.example/photo' });
    const response = await postImageUpload(request, { put }, 'blob-token');

    expect(response.status).toBe(200);
    expect(put).toHaveBeenCalledWith('photo.png', expect.any(ArrayBuffer), expect.objectContaining({ contentType: 'image/jpeg' }));
  });

  it('500s and does not leak details when Blob storage fails', async () => {
    const put = vi.fn().mockRejectedValue(new Error('blob API down'));
    const response = await postImageUpload(uploadRequest(), { put }, 'blob-token');

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('blob API down');
  });
});
