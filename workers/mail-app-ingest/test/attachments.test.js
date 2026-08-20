import { describe, expect, test, vi } from 'vitest';
import {
  attachmentBlobPath,
  deleteUploadedAttachments,
  uploadAttachments,
} from '../src/attachments.js';

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

  test('uses distinct paths for separate deliveries of the same message', async () => {
    const first = await attachmentBlobPath('<message@example.com>', 0, 'delivery-1');
    const duplicate = await attachmentBlobPath('<message@example.com>', 0, 'delivery-2');

    expect(first).not.toBe(duplicate);
    expect(first).toMatch(/^mail-attachments\/[a-f0-9]{64}\/0$/u);
    expect(duplicate).toMatch(/^mail-attachments\/[a-f0-9]{64}\/0$/u);
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
        allowOverwrite: false,
      }),
    );
  });

  test('cannot overwrite an attachment from an earlier delivery', async () => {
    const objects = new Map();
    const putBlob = vi.fn(async (pathname, content, options) => {
      if (!options.allowOverwrite && objects.has(pathname)) {
        throw new Error('object already exists');
      }
      objects.set(pathname, new Uint8Array(content));
      const url = `https://store.private.blob.vercel-storage.com/${pathname}`;
      return {
        url,
        downloadUrl: `${url}?download=1`,
        pathname,
        contentType: 'application/pdf',
        contentDisposition: 'inline',
        etag: 'etag',
      };
    });

    const original = await uploadAttachments(
      [attachment],
      '<message@example.com>',
      'secret-token',
      putBlob,
    );
    const replacement = {
      ...attachment,
      content: new Uint8Array([9, 9, 9]).buffer,
    };
    const duplicate = await uploadAttachments(
      [replacement],
      '<message@example.com>',
      'secret-token',
      putBlob,
    );

    expect(original.failures).toEqual([]);
    expect(duplicate.failures).toEqual([]);
    expect(objects).toHaveLength(2);
    expect(original.attachments[0].blob_url).not.toBe(duplicate.attachments[0].blob_url);
    expect([...objects.values()].map((bytes) => [...bytes])).toEqual([
      [1, 2, 3],
      [9, 9, 9],
    ]);
    expect(putBlob).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(ArrayBuffer),
      expect.objectContaining({ allowOverwrite: false }),
    );
  });

  test('isolates an upload failure and keeps metadata storable', async () => {
    const error = new Error('upload failed');
    const result = await uploadAttachments(
      [attachment],
      '<message@example.com>',
      'secret-token',
      vi.fn(async () => {
        throw error;
      }),
    );

    expect(result.attachments[0]).toMatchObject({ filename: 'plan.pdf', blob_url: null });
    expect(result.attachments[0].content).toBeUndefined();
    expect(result.failures).toEqual([{ index: 0, error }]);
  });

  test('uploads with bounded concurrency while preserving input order', async () => {
    let active = 0;
    let maximumActive = 0;
    const putBlob = vi.fn(async (pathname) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const url = `https://store.private.blob.vercel-storage.com/${pathname}`;
      return {
        url,
        downloadUrl: `${url}?download=1`,
        pathname,
        contentType: 'application/pdf',
        contentDisposition: 'inline',
        etag: 'etag',
      };
    });

    const result = await uploadAttachments(
      Array.from({ length: 9 }, (_, index) => ({ ...attachment, filename: `${index}.pdf` })),
      '<message@example.com>',
      'secret-token',
      putBlob,
    );

    expect(maximumActive).toBe(4);
    expect(result.attachments.map(({ filename }) => filename)).toEqual(
      Array.from({ length: 9 }, (_, index) => `${index}.pdf`),
    );
  });

  test('deletes every successfully uploaded blob in one request', async () => {
    const deleteBlob = vi.fn(async () => undefined);
    const deleted = await deleteUploadedAttachments(
      [
        { blob_url: 'https://blob.example/one' },
        { blob_url: null },
        { blob_url: 'https://blob.example/two' },
      ],
      'secret-token',
      deleteBlob,
    );

    expect(deleted).toBe(2);
    expect(deleteBlob).toHaveBeenCalledWith(
      ['https://blob.example/one', 'https://blob.example/two'],
      { token: 'secret-token' },
    );
  });
});
