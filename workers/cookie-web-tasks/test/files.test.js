import { describe, expect, it, vi } from 'vitest';
import { createMockSql } from './helpers.js';
import {
  MAX_FILE_BYTES,
  contentDisposition,
  deleteFile,
  getFile,
  getFileContent,
  listFiles,
  sniffFileType,
  updateFile,
  uploadFile,
} from '../src/files.js';

const USER = 'user-1';
const FILE_ID = '33333333-3333-4333-8333-333333333333';
const FOLDER_ID = '44444444-4444-4444-8444-444444444444';
const ROW = {
  id: FILE_ID,
  folder_id: null,
  name: 'notes.pdf',
  mime_type: 'application/pdf',
  size_bytes: 10,
  object_key: `${USER}/${FILE_ID}`,
  created_at: 't0',
  updated_at: 't0',
};
const PUBLIC_ROW = (({ object_key: _key, ...rest }) => rest)(ROW);
const allow = { allowRequest: async () => true };

function pdfBytes() {
  return new TextEncoder().encode('%PDF-1.4 x');
}

function pngBytes() {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
}

/** @param {{name?: string, type?: string, bytes?: Uint8Array, folder?: string, field?: string}} [opts] */
function uploadRequest({
  name = 'notes.pdf',
  type = 'application/pdf',
  bytes = pdfBytes(),
  folder,
  field = 'file',
} = {}) {
  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);
  const form = new FormData();
  form.set(field, new File([payload], name, { type }));
  if (folder) form.set('folder', folder);
  return new Request('https://cookie-web-tasks.example/files', { method: 'POST', body: form });
}

/** @returns {any} Shaped like the R2Bucket binding, loosely typed for stubbing. */
function r2() {
  return {
    put: vi.fn(async () => ({})),
    get: vi.fn(),
    delete: vi.fn(async () => undefined),
  };
}

describe('sniffFileType', () => {
  it('recognises a PDF', () => {
    expect(sniffFileType(pdfBytes().buffer)).toBe('application/pdf');
  });
  it('recognises a PNG', () => {
    expect(sniffFileType(pngBytes().buffer)).toBe('image/png');
  });
  it('returns null for anything else', () => {
    expect(sniffFileType(new Uint8Array([1, 2, 3, 4, 5]).buffer)).toBeNull();
  });
});

describe('contentDisposition', () => {
  it('encodes non-ASCII names per RFC 5987 and quotes the ASCII fallback', () => {
    expect(contentDisposition('résumé "final".pdf', true)).toBe(
      `inline; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
    expect(contentDisposition('a.zip', false)).toBe(
      `attachment; filename="a.zip"; filename*=UTF-8''a.zip`,
    );
  });
});

describe('listFiles', () => {
  it('lists the root when no folder is given', async () => {
    const sql = createMockSql([[PUBLIC_ROW]]);
    const response = await listFiles(sql, USER, new URL('https://x/files'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ files: [PUBLIC_ROW] });
    expect(sql.calls[0].text).toContain('folder_id IS NULL');
  });
  it('lists a folder by id', async () => {
    const sql = createMockSql([[]]);
    await listFiles(sql, USER, new URL(`https://x/files?folder=${FOLDER_ID}`));
    expect(sql.calls[0].values).toContain(FOLDER_ID);
  });
  it('rejects a malformed folder id', async () => {
    const response = await listFiles(createMockSql(), USER, new URL('https://x/files?folder=nope'));
    expect(response.status).toBe(400);
  });
});

describe('uploadFile', () => {
  it('writes the object then the row and returns the row', async () => {
    const env = { FILES: r2() };
    const sql = createMockSql([[PUBLIC_ROW]]);
    const response = await uploadFile(uploadRequest(), sql, USER, env, allow);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ file: PUBLIC_ROW });
    expect(env.FILES.put).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${USER}/[0-9a-f-]{36}$`)),
      expect.any(ArrayBuffer),
      { httpMetadata: { contentType: 'application/pdf' } },
    );
    expect(sql.calls[0].text).toContain('INSERT INTO document_files');
    expect(sql.calls[0].values).toEqual(
      expect.arrayContaining([USER, null, 'notes.pdf', 'application/pdf', 10]),
    );
  });

  it('prefers the sniffed type over the client type', async () => {
    const env = { FILES: r2() };
    await uploadFile(
      uploadRequest({ name: 'x.bin', type: 'text/plain', bytes: pngBytes() }),
      createMockSql([[PUBLIC_ROW]]),
      USER,
      env,
      allow,
    );
    expect(env.FILES.put.mock.calls[0][2]).toEqual({ httpMetadata: { contentType: 'image/png' } });
  });

  it('falls back to octet-stream when the client type is missing and nothing sniffs', async () => {
    const env = { FILES: r2() };
    await uploadFile(
      uploadRequest({ name: 'x.bin', type: '', bytes: new Uint8Array([1, 2, 3]) }),
      createMockSql([[PUBLIC_ROW]]),
      USER,
      env,
      allow,
    );
    expect(env.FILES.put.mock.calls[0][2]).toEqual({
      httpMetadata: { contentType: 'application/octet-stream' },
    });
  });

  it('validates the folder belongs to the caller', async () => {
    const env = { FILES: r2() };
    const response = await uploadFile(
      uploadRequest({ folder: FOLDER_ID }),
      createMockSql([[]]),
      USER,
      env,
      allow,
    );
    expect(response.status).toBe(404);
    expect(env.FILES.put).not.toHaveBeenCalled();
  });

  it('deletes the object when the row insert fails', async () => {
    const env = { FILES: r2() };
    const sql = createMockSql();
    sql.mockRejectedValueOnce(new Error('insert failed'));
    const response = await uploadFile(uploadRequest(), sql, USER, env, allow);
    expect(response.status).toBe(500);
    expect(env.FILES.delete).toHaveBeenCalledWith(env.FILES.put.mock.calls[0][0]);
  });

  it('rejects an oversized declared body before reading it', async () => {
    const request = new Request('https://x/files', {
      method: 'POST',
      headers: { 'Content-Length': String(MAX_FILE_BYTES + 1_000_000) },
      body: 'x',
    });
    const response = await uploadFile(request, createMockSql(), USER, { FILES: r2() }, allow);
    expect(response.status).toBe(413);
  });

  it('rejects an oversized file after reading it', async () => {
    const env = { FILES: r2() };
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    const response = await uploadFile(
      uploadRequest({ bytes: big }),
      createMockSql(),
      USER,
      env,
      allow,
    );
    expect(response.status).toBe(413);
    expect(env.FILES.put).not.toHaveBeenCalled();
  });

  it('rejects a request with no file field', async () => {
    const response = await uploadFile(
      uploadRequest({ field: 'other' }),
      createMockSql(),
      USER,
      { FILES: r2() },
      allow,
    );
    expect(response.status).toBe(400);
  });

  it('answers 429 when the rate limit refuses', async () => {
    const response = await uploadFile(
      uploadRequest(),
      createMockSql(),
      USER,
      { FILES: r2() },
      { allowRequest: async () => false },
    );
    expect(response.status).toBe(429);
  });

  it('answers 503 without a bucket binding', async () => {
    const response = await uploadFile(uploadRequest(), createMockSql(), USER, {}, allow);
    expect(response.status).toBe(503);
  });
});

describe('getFile', () => {
  it('returns the row', async () => {
    const response = await getFile(createMockSql([[PUBLIC_ROW]]), USER, FILE_ID);
    expect(await response.json()).toEqual({ file: PUBLIC_ROW });
  });
  it('404s for a missing or foreign id', async () => {
    const response = await getFile(createMockSql([[]]), USER, FILE_ID);
    expect(response.status).toBe(404);
  });
});

describe('getFileContent', () => {
  it('streams the object inline for a PDF with private caching', async () => {
    const env = { FILES: r2() };
    env.FILES.get.mockResolvedValue({
      body: new Blob(['hello']).stream(),
      size: 5,
      httpMetadata: { contentType: 'application/pdf' },
    });
    const response = await getFileContent(createMockSql([[ROW]]), USER, FILE_ID, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Length')).toBe('5');
    expect(response.headers.get('Content-Disposition')).toContain('inline; filename="notes.pdf"');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.text()).toBe('hello');
    expect(env.FILES.get).toHaveBeenCalledWith(ROW.object_key);
  });

  it('serves anything else as an attachment', async () => {
    const env = { FILES: r2() };
    env.FILES.get.mockResolvedValue({ body: new Blob(['x']).stream(), size: 1, httpMetadata: {} });
    const sql = createMockSql([[{ ...ROW, name: 'a.zip', mime_type: 'application/zip' }]]);
    const response = await getFileContent(sql, USER, FILE_ID, env);
    expect(response.headers.get('Content-Disposition')).toContain('attachment;');
    expect(response.headers.get('Content-Type')).toBe('application/zip');
  });

  it('404s when the row is missing', async () => {
    const response = await getFileContent(createMockSql([[]]), USER, FILE_ID, { FILES: r2() });
    expect(response.status).toBe(404);
  });

  it('404s when the object is missing', async () => {
    const env = { FILES: r2() };
    env.FILES.get.mockResolvedValue(null);
    const response = await getFileContent(createMockSql([[ROW]]), USER, FILE_ID, env);
    expect(response.status).toBe(404);
  });
});

describe('updateFile', () => {
  it('renames', async () => {
    const sql = createMockSql([[{ ...PUBLIC_ROW, name: 'renamed.pdf' }]]);
    const response = await updateFile(sql, USER, FILE_ID, { name: '  renamed.pdf ' });
    expect((await response.json()).file.name).toBe('renamed.pdf');
    expect(sql.calls[0].text).toContain('SET(name)');
    expect(sql.calls[1].text).toContain('UPDATE document_files');
  });
  it('moves to an owned folder', async () => {
    const sql = createMockSql([[{ id: FOLDER_ID }], [{ ...PUBLIC_ROW, folder_id: FOLDER_ID }]]);
    const response = await updateFile(sql, USER, FILE_ID, { folder: FOLDER_ID });
    expect((await response.json()).file.folder_id).toBe(FOLDER_ID);
  });
  it('moves to the root with folder null', async () => {
    const response = await updateFile(createMockSql([[PUBLIC_ROW]]), USER, FILE_ID, {
      folder: null,
    });
    expect(response.status).toBe(200);
  });
  it('refuses a foreign folder', async () => {
    const response = await updateFile(createMockSql([[]]), USER, FILE_ID, { folder: FOLDER_ID });
    expect(response.status).toBe(404);
  });
  it('refuses an empty name and an empty body', async () => {
    expect((await updateFile(createMockSql(), USER, FILE_ID, { name: '   ' })).status).toBe(400);
    expect((await updateFile(createMockSql(), USER, FILE_ID, {})).status).toBe(400);
  });
  it('404s when nothing was updated', async () => {
    const response = await updateFile(createMockSql([[]]), USER, FILE_ID, { name: 'x' });
    expect(response.status).toBe(404);
  });
});

describe('deleteFile', () => {
  it('deletes the row then the object', async () => {
    const env = { FILES: r2() };
    const sql = createMockSql([[ROW]]);
    const response = await deleteFile(sql, USER, FILE_ID, env);
    expect(response.status).toBe(204);
    expect(sql.calls[0].text).toContain('DELETE FROM document_files');
    expect(env.FILES.delete).toHaveBeenCalledWith(ROW.object_key);
  });
  it('still answers 204 when the object delete fails, reporting it', async () => {
    const env = { FILES: r2() };
    env.FILES.delete.mockRejectedValue(new Error('r2 down'));
    const report = vi.fn();
    const response = await deleteFile(createMockSql([[ROW]]), USER, FILE_ID, env, { report });
    expect(response.status).toBe(204);
    expect(report).toHaveBeenCalledWith('file_object_delete', expect.any(Error), {
      file_id: FILE_ID,
    });
  });
  it('404s for a missing row', async () => {
    const response = await deleteFile(createMockSql([[]]), USER, FILE_ID, { FILES: r2() });
    expect(response.status).toBe(404);
  });
});
