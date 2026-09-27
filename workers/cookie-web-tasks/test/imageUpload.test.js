import { describe, expect, it, vi } from 'vitest';
import { getDocumentImageUrl, postImageUpload, sniffImageType } from '../src/imageUpload.js';

function pngBytes(length = 16) {
  const bytes = new Uint8Array(Math.max(length, 8));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

/** @param {{name?: string, type?: string, bytes?: Uint8Array | number}} [opts] */
function uploadRequest({ name = 'photo.png', type = 'image/png', bytes = pngBytes() } = {}) {
  const body = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes;
  const payload = new ArrayBuffer(body.byteLength);
  new Uint8Array(payload).set(body);
  const form = new FormData();
  form.set('image', new File([payload], name, { type }));
  return new Request('https://cookie-web-tasks.example/tasks/image-upload', {
    method: 'POST',
    body: form,
  });
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
    const response = await postImageUpload(
      uploadRequest(),
      { put, userId: 'user-1' },
      'blob-token',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://blob.example/photo.png' });
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^documents\/user-1\/[0-9a-f-]{36}\.png$/),
      expect.any(ArrayBuffer),
      {
        access: 'private',
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
    const request = new Request('https://cookie-web-tasks.example/tasks/image-upload', {
      method: 'POST',
      body: form,
    });

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
    const response = await postImageUpload(
      uploadRequest({ bytes: 5 * 1024 * 1024 + 1 }),
      { put },
      'blob-token',
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('5MB limit');
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects bytes that do not match a known image signature', async () => {
    const put = vi.fn();
    const response = await postImageUpload(
      uploadRequest({ type: 'image/png', bytes: new Uint8Array(16) }),
      { put },
      'blob-token',
    );

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

describe('postImageUpload failures', () => {
  it('reports a storage failure instead of only logging it', async () => {
    const error = new Error('Vercel Blob: Cannot use public access on a private store.');
    const put = vi.fn().mockRejectedValue(error);
    const report = vi.fn();
    const response = await postImageUpload(
      uploadRequest(),
      { put, report, userId: 'user-1' },
      'blob-token',
    );
    expect(response.status).toBe(500);
    expect(report).toHaveBeenCalledWith('image_upload', error);
  });
});

describe('getDocumentImageUrl', () => {
  const USER = '11111111-1111-4111-8111-111111111111';
  const own = `https://store1.private.blob.vercel-storage.com/documents/${USER}/abc-XYZ.png`;

  function signer(overrides = {}) {
    return {
      issueSignedToken: vi.fn().mockResolvedValue('signed-token'),
      presignUrl: vi.fn().mockResolvedValue({ presignedUrl: `${own}?sig=1` }),
      token: 'blob-token',
      now: () => Date.parse('2026-09-27T09:00:00Z'),
      ...overrides,
    };
  }

  function requestFor(url) {
    const request = new URL('https://tasks.example/tasks/document-image');
    if (url !== undefined) request.searchParams.set('url', url);
    return request;
  }

  it("signs a short-lived GET link for the caller's own image", async () => {
    const s = signer();
    const response = await getDocumentImageUrl(requestFor(own), USER, s);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      url: `${own}?sig=1`,
      expiresAt: '2026-09-27T10:00:00.000Z',
    });
    expect(s.issueSignedToken).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: `documents/${USER}/abc-XYZ.png`, operations: ['get'] }),
    );
    expect(s.presignUrl).toHaveBeenCalledWith(
      'signed-token',
      expect.objectContaining({ access: 'private', operation: 'get' }),
    );
  });

  it.each([
    ['another user', `https://store1.private.blob.vercel-storage.com/documents/other/abc.png`, 404],
    [
      'a mail attachment',
      `https://store1.private.blob.vercel-storage.com/attachments/${USER}/a.pdf`,
      404,
    ],
    [
      'a traversal',
      `https://store1.private.blob.vercel-storage.com/documents/${USER}/%2E%2E/x.png`,
      404,
    ],
    [
      'a public store',
      `https://store1.public.blob.vercel-storage.com/documents/${USER}/a.png`,
      400,
    ],
    ['another host', `https://evil.example/documents/${USER}/a.png`, 400],
    ['a missing url', undefined, 400],
  ])('refuses %s', async (_label, url, status) => {
    const s = signer();
    const response = await getDocumentImageUrl(requestFor(url), USER, s);
    expect(response.status).toBe(status);
    expect(s.issueSignedToken).not.toHaveBeenCalled();
  });

  it('503s without a storage token', async () => {
    const response = await getDocumentImageUrl(requestFor(own), USER, signer({ token: undefined }));
    expect(response.status).toBe(503);
  });
});
