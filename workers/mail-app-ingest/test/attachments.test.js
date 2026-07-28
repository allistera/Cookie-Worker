import { describe, expect, test, vi } from 'vitest';
import { attachmentBlobPath, uploadAttachments } from '../src/attachments.js';

const attachment = {
  filename: 'plan.pdf',
  mime_type: 'application/pdf',
  size: 3,
  content: new Uint8Array([1, 2, 3]).buffer,
};

describe('attachment uploads', () => {
  test('builds stable private paths without sender filenames', async () => {
    const first = await attachmentBlobPath('<message@example.com>', 0);
    const again = await attachmentBlobPath('<message@example.com>', 0);

    expect(first).toBe(again);
    expect(first).toMatch(/^mail-attachments\/[a-f0-9]{64}\/0$/u);
    expect(first).not.toContain('message@example.com');
  });

  test('uploads bytes privately and returns the stored URL', async () => {
    const putBlob = vi.fn(async (pathname) => ({
      url: `https://store.private.blob.vercel-storage.com/${pathname}`,
      downloadUrl: `https://store.private.blob.vercel-storage.com/${pathname}?download=1`,
      pathname,
      contentType: 'application/pdf',
      contentDisposition: 'inline',
      etag: 'etag-1',
    }));

    const result = await uploadAttachments(
      [attachment],
      '<message@example.com>',
      'secret-token',
      putBlob,
    );

    expect(result.failures).toEqual([]);
    expect(result.attachments[0]).toMatchObject({
      filename: 'plan.pdf',
      size: 3,
      blob_url: expect.stringMatching(/private\.blob\.vercel-storage\.com/u),
    });
    expect(result.attachments[0].content).toBeUndefined();
    expect(putBlob).toHaveBeenCalledWith(
      expect.stringMatching(/^mail-attachments\/[a-f0-9]{64}\/0$/u),
      attachment.content,
      expect.objectContaining({
        access: 'private',
        token: 'secret-token',
        contentType: 'application/pdf',
        allowOverwrite: true,
      }),
    );
  });

  test('isolates an upload failure and keeps metadata storable', async () => {
    const error = new Error('upload failed');
    const result = await uploadAttachments(
      [attachment],
      '<message@example.com>',
      'secret-token',
      vi.fn(async () => { throw error; }),
    );

    expect(result.attachments[0]).toMatchObject({ filename: 'plan.pdf', blob_url: null });
    expect(result.attachments[0].content).toBeUndefined();
    expect(result.failures).toEqual([{ index: 0, error }]);
  });
});
