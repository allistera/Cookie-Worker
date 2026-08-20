import { describe, expect, it, vi } from 'vitest';
import { postImageUpload, sniffImageType } from '../src/imageUpload.js';

function pngBytes(length = 16) {
  const bytes = new Uint8Array(Math.max(length, 8));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

/** @param {{name?: string, type?: string, bytes?: Uint8Array | number}} [opts] */
function uploadRequest({ name = 'photo.png', type = 'image/png', bytes = pngBytes() } = {}) {
  const body = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes;
  const form = new FormData();
  form.set('image', new File([body], name, { type }));
  return new Request('https://cookie-web-tasks.example/tasks/image-upload', { method: 'POST', body: form });
}

describe('sniffImageType', () => {
  it('recognizes a PNG signature', () => {
    expect(sniffImageType(pngBytes().buffer)).toEqual({ type: 'image/png', ext: 'png' });
  });

  it('rejects bytes that are not an image', () => {
    expect(sniffImageType(new Uint8Array([0x00, 0x01, 0x02, 0x03]).buffer)).toBeNull();
  });
});

describe('postImageUpload', () => {
  it('stores the image under a generated key and returns its blob URL', async () => {
    const put = vi.fn().mockResolvedValue({ url: 'https://blob.example/photo.png' });
    const response = await postImageUpload(uploadRequest(), { put, userId: 'user-1' }, 'blob-token');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://blob.example/photo.png' });
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^documents\/user-1\/[0-9a-f-]{36}\.png$/),
      expect.any(ArrayBuffer),
      {
        access: 'public',
        contentType: 'image/png',
        token: 'blob-token',
        addRandomSuffix: true,
      },
    );
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

  it('rejects bytes that do not match a known image signature', async () => {
    const put = vi.fn();
    const response = await postImageUpload(uploadRequest({ type: 'image/png', bytes: new Uint8Array(16) }), { put }, 'blob-token');

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Invalid file type');
    expect(put).not.toHaveBeenCalled();
  });

  it('503s when Blob storage is not configured', async () => {
    const put = vi.fn();
    const response = await postImageUpload(uploadRequest(), { put }, undefined);
    expect(response.status).toBe(503);
    expect(put).not.toHaveBeenCalled();
  });

  it('500s and does not leak details when Blob storage fails', async () => {
    const put = vi.fn().mockRejectedValue(new Error('blob API down'));
    const response = await postImageUpload(uploadRequest(), { put }, 'blob-token');

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('blob API down');
  });
});
