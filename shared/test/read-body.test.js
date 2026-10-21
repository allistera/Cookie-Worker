import { describe, expect, it } from 'vitest';
import {
  BodyTooLargeError,
  InvalidJsonError,
  InvalidFormError,
  UnsupportedContentTypeError,
  bodyErrorResponse,
  readJsonBody,
  readFormBody,
} from '../read-body.js';

describe('bounded multipart streams', () => {
  it.each([undefined, 'application/json'])('rejects content type %s', async (contentType) => {
    const request = new Request('https://example.invalid', {
      method: 'POST',
      headers: contentType ? { 'content-type': contentType } : {},
    });
    await expect(readFormBody(request, { maxBytes: 100, fields: [] })).rejects.toThrow(
      'Content-Type must be multipart/form-data',
    );
  });

  it('rejects declared oversized uploads before reading', async () => {
    const request = new Request('https://example.invalid', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=test', 'content-length': '101' },
    });
    await expect(readFormBody(request, { maxBytes: 100, fields: [] })).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it('distinguishes missing and malformed multipart bodies', async () => {
    const headers = { 'content-type': 'multipart/form-data; boundary=test' };
    await expect(
      readFormBody(new Request('https://example.invalid', { method: 'POST', headers }), {
        maxBytes: 100,
        fields: [],
      }),
    ).rejects.toThrow('Missing multipart body');
    await expect(
      readFormBody(
        new Request('https://example.invalid', { method: 'POST', headers, body: 'broken' }),
        { maxBytes: 100, fields: [] },
      ),
    ).rejects.toThrow('Invalid multipart body');
  });

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
  it.each([undefined, 'text/plain'])('rejects required JSON content type %s', async (type) => {
    const request = new Request('https://example.invalid', {
      method: 'POST',
      headers: type ? { 'content-type': type } : {},
    });
    await expect(readJsonBody(request, { requireContentType: true })).rejects.toBeInstanceOf(
      UnsupportedContentTypeError,
    );
  });

  it('accepts a JSON content type with charset', async () => {
    const request = new Request('https://example.invalid', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"ok":true}',
    });
    await expect(readJsonBody(request, { requireContentType: true })).resolves.toEqual({
      ok: true,
    });
  });

  it('rejects declared oversized JSON bodies before reading', async () => {
    const request = new Request('https://example.invalid', {
      method: 'POST',
      headers: { 'content-length': '101' },
    });
    await expect(readJsonBody(request, { maxBytes: 100 })).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

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

describe('body error responses', () => {
  it.each([
    [new BodyTooLargeError(), 413, 'Payload too large'],
    [new UnsupportedContentTypeError('Use JSON'), 415, 'Use JSON'],
    [new InvalidJsonError(), 400, 'Invalid JSON body'],
    [new InvalidFormError('Missing field'), 400, 'Missing field'],
  ])('maps %s to HTTP %s', async (error, status, message) => {
    const response = bodyErrorResponse(error);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
  });

  it('leaves unrelated errors for the caller', () => {
    expect(bodyErrorResponse(new Error('database unavailable'))).toBeNull();
  });
});
