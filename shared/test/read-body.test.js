import { describe, expect, it } from 'vitest';
import {
  BodyTooLargeError,
  InvalidJsonError,
  InvalidFormError,
  readJsonBody,
  readFormBody,
} from '../read-body.js';

describe('bounded multipart streams', () => {
  it('cancels undeclared oversized multipart before parsing', async () => {
    let consumed = 0;
    let cancelled = false;
    const request = new Request('https://example.invalid', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=test' },
      body: new ReadableStream({
        pull(controller) {
          consumed += 1024;
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
      ...{ duplex: 'half' },
    });
    await expect(
      readFormBody(request, { maxBytes: 2048, fields: ['file'] }),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
    expect(consumed).toBeLessThanOrEqual(4096);
  });

  it.each(['unknown', 'duplicate'])('rejects %s fields', async (kind) => {
    const form = new FormData();
    form.append('file', new File(['data'], 'example.txt'));
    form.append(kind === 'duplicate' ? 'file' : 'padding', 'ignored');
    const request = new Request('https://example.invalid', { method: 'POST', body: form });
    await expect(
      readFormBody(request, { maxBytes: 4096, fields: ['file'] }),
    ).rejects.toBeInstanceOf(InvalidFormError);
  });

  it('preserves valid file bytes and allowed text fields', async () => {
    const form = new FormData();
    form.append('file', new File(['文😀'], 'example.txt'));
    form.append('folder', 'root');
    const result = await readFormBody(
      new Request('https://example.invalid', { method: 'POST', body: form }),
      { maxBytes: 4096, fields: ['file', 'folder'] },
    );
    expect(await result.get('file').text()).toBe('文😀');
    expect(result.get('folder')).toBe('root');
  });
});

describe('bounded JSON streams', () => {
  it('cancels a body without Content-Length before consuming the whole upload', async () => {
    let consumed = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        consumed += 1024;
        controller.enqueue(new Uint8Array(1024));
        if (consumed === 1024 * 1024) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('https://example.invalid', {
      method: 'POST',
      body: stream,
      ...{ duplex: 'half' },
    });
    await expect(readJsonBody(request, { maxBytes: 2048 })).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    expect(cancelled).toBe(true);
    expect(consumed).toBeLessThanOrEqual(4096);
  });
  it('decodes UTF-8 characters split across chunks and accepts the exact byte limit', async () => {
    const bytes = new TextEncoder().encode('{"text":"文😀"}');
    const stream = new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const request = new Request('https://example.invalid', {
      method: 'POST',
      body: stream,
      ...{ duplex: 'half' },
    });
    await expect(readJsonBody(request, { maxBytes: bytes.length })).resolves.toEqual({
      text: '文😀',
    });
  });
  it('retains empty-body and invalid-JSON behaviour', async () => {
    await expect(
      readJsonBody(new Request('https://example.invalid', { method: 'POST' })),
    ).resolves.toEqual({});
    await expect(
      readJsonBody(new Request('https://example.invalid', { method: 'POST', body: '{' })),
    ).rejects.toBeInstanceOf(InvalidJsonError);
  });
});
