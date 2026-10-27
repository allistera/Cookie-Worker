import { describe, expect, it, vi } from 'vitest';
import {
  attachmentPathname,
  deleteAttachment,
  handleAttachments,
  sanitizeAttachmentFilename,
  uploadAttachment,
} from '../src/attachments.js';
import { MAX_OUTBOUND_ATTACHMENT_BYTES } from '../src/outbound.js';
import { createMockSql } from './helpers.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const ATTACHMENT_ID = '22222222-2222-2222-2222-222222222222';
const DRAFT_ID = '33333333-3333-3333-3333-333333333333';
const BLOB_URL =
  'https://store.private.blob.vercel-storage.com/outbound-attachments/x/report-abc.pdf';

/** @param {{name?: string, type?: string, bytes?: number}} [opts] */
function uploadRequest({ name = 'report.pdf', type = 'application/pdf', bytes = 5 } = {}) {
  const payload = new ArrayBuffer(bytes);
  new Uint8Array(payload).fill(1);
  const form = new FormData();
  form.set('file', new File([payload], name, { type }));
  return new Request('https://cookie-web-send.example/send/attachments', {
    method: 'POST',
    body: form,
  });
}

/** @param {Partial<import('../src/outbound.js').SendServices>} [overrides] */
function services(overrides = {}) {
  return /** @type {any} */ ({
    env: { BLOB_READ_WRITE_TOKEN: 'blob-token' },
    putBlob: vi.fn(async () => ({ url: BLOB_URL })),
    deleteBlob: vi.fn(async () => undefined),
    ...overrides,
  });
}

const allowed = [{ allowed: true }];
const storedRow = [
  { id: ATTACHMENT_ID, filename: 'report.pdf', content_type: 'application/pdf', size_bytes: 5 },
];

describe('sanitizeAttachmentFilename', () => {
  it('keeps only the basename so a path cannot travel with the file', () => {
    expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentFilename('C:\\Users\\me\\notes.txt')).toBe('notes.txt');
  });

  it('strips control characters that could forge provider headers', () => {
    expect(sanitizeAttachmentFilename('bad\r\nX-Injected: yes\u0000.pdf')).toBe(
      'badX-Injected: yes.pdf',
    );
  });

  it('falls back to a generic name when nothing usable is left', () => {
    expect(sanitizeAttachmentFilename('')).toBe('attachment');
    expect(sanitizeAttachmentFilename('..')).toBe('attachment');
    expect(sanitizeAttachmentFilename(null)).toBe('attachment');
  });

  it('caps the length', () => {
    expect(sanitizeAttachmentFilename('a'.repeat(300))).toHaveLength(200);
  });
});

describe('attachmentPathname', () => {
  it('keys the object under the caller prefix with a safe name', () => {
    expect(attachmentPathname(USER_ID, 'Q3 résumé (final).pdf')).toBe(
      `outbound-attachments/${USER_ID}/Q3_r_sum___final_.pdf`,
    );
    expect(attachmentPathname(USER_ID, '***')).toBe(`outbound-attachments/${USER_ID}/___`);
  });
});

describe('POST /send/attachments', () => {
  it('reports storage as unconfigured when no blob token is present', async () => {
    const sql = createMockSql();
    const deps = services({ env: /** @type {any} */ ({}) });
    const response = await uploadAttachment(uploadRequest(), sql, USER_ID, deps);
    expect(response.status).toBe(503);
    expect(sql).not.toHaveBeenCalled();
    expect(deps.putBlob).not.toHaveBeenCalled();
  });

  it('refuses a declared body past the ceiling before reading it', async () => {
    const sql = createMockSql();
    const deps = services();
    const request = new Request('https://cookie-web-send.example/send/attachments', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=x',
        'Content-Length': String(MAX_OUTBOUND_ATTACHMENT_BYTES + 128 * 1024),
      },
      body: 'ignored',
    });
    const response = await uploadAttachment(request, sql, USER_ID, deps);
    expect(response.status).toBe(413);
    expect(sql).not.toHaveBeenCalled();
  });

  it('answers 429 once the per-minute upload allowance is spent', async () => {
    const sql = createMockSql([[{ allowed: false }]]);
    const deps = services();
    const response = await uploadAttachment(uploadRequest(), sql, USER_ID, deps);
    expect(response.status).toBe(429);
    expect(sql.calls[0].values).toContain('attachment-upload');
    expect(deps.putBlob).not.toHaveBeenCalled();
  });

  it('rejects a body that is not multipart', async () => {
    const sql = createMockSql([allowed]);
    const request = new Request('https://cookie-web-send.example/send/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const response = await uploadAttachment(request, sql, USER_ID, services());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('multipart/form-data');
  });

  it('rejects a form without a file field', async () => {
    const sql = createMockSql([allowed]);
    const form = new FormData();
    form.set('file', 'just text');
    const request = new Request('https://cookie-web-send.example/send/attachments', {
      method: 'POST',
      body: form,
    });
    const response = await uploadAttachment(request, sql, USER_ID, services());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'A file field is required' });
  });

  it('rejects an empty file', async () => {
    const sql = createMockSql([allowed]);
    const deps = services();
    const response = await uploadAttachment(uploadRequest({ bytes: 0 }), sql, USER_ID, deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'That file is empty' });
    expect(deps.putBlob).not.toHaveBeenCalled();
  });

  it('rejects a file past the outbound size ceiling', async () => {
    const sql = createMockSql([allowed]);
    const deps = services();
    const response = await uploadAttachment(
      uploadRequest({ bytes: MAX_OUTBOUND_ATTACHMENT_BYTES + 1 }),
      sql,
      USER_ID,
      deps,
    );
    expect(response.status).toBe(413);
    expect(deps.putBlob).not.toHaveBeenCalled();
  });

  it('stores the bytes under the caller prefix, records cleanup first, then the row', async () => {
    const sql = createMockSql([allowed, [], storedRow]);
    const deps = services();
    const response = await uploadAttachment(
      uploadRequest({ name: '../report.pdf', type: 'application/pdf; charset=binary' }),
      sql,
      USER_ID,
      deps,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ attachment: storedRow[0] });

    expect(deps.putBlob).toHaveBeenCalledOnce();
    const [pathname, bytes, options] = deps.putBlob.mock.calls[0];
    expect(pathname).toBe(`outbound-attachments/${USER_ID}/report.pdf`);
    expect(bytes.byteLength).toBe(5);
    expect(options).toEqual({
      access: 'private',
      token: 'blob-token',
      contentType: 'application/pdf',
      addRandomSuffix: true,
      allowOverwrite: false,
      multipart: false,
    });

    expect(sql.calls.map((call) => call.text.trim().split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'WITH claimed AS',
      'INSERT INTO object_cleanup_jobs',
      'INSERT INTO outbound_attachments',
    ]);
    expect(sql.calls[1].values).toEqual(['blob', BLOB_URL, 24]);
    expect(sql.calls[2].values).toEqual([USER_ID, 'report.pdf', 'application/pdf', 5, BLOB_URL]);
    expect(deps.deleteBlob).not.toHaveBeenCalled();
  });

  it('switches to a multipart put above the threshold and keeps an unknown type generic', async () => {
    const sql = createMockSql([allowed, [], storedRow]);
    const deps = services();
    const response = await uploadAttachment(
      uploadRequest({ name: 'blob.bin', type: 'not a type', bytes: 4 * 1024 * 1024 + 1 }),
      sql,
      USER_ID,
      deps,
    );
    expect(response.status).toBe(201);
    expect(deps.putBlob.mock.calls[0][2]).toMatchObject({
      multipart: true,
      contentType: 'application/octet-stream',
    });
  });

  it('removes the blob when its cleanup pointer could not be recorded', async () => {
    const sql = createMockSql([allowed]);
    sql.mockImplementationOnce(() => Promise.resolve(allowed));
    sql.mockImplementationOnce(() => Promise.reject(new Error('database unavailable')));
    const deps = services();
    await expect(uploadAttachment(uploadRequest(), sql, USER_ID, deps)).rejects.toThrow(
      'database unavailable',
    );
    expect(deps.deleteBlob).toHaveBeenCalledWith(BLOB_URL);
  });

  it('removes the blob when the row insert fails after the pointer was recorded', async () => {
    const sql = createMockSql();
    sql.mockImplementationOnce(() => Promise.resolve(allowed));
    sql.mockImplementationOnce(() => Promise.resolve([]));
    sql.mockImplementationOnce(() => Promise.reject(new Error('insert failed')));
    const deps = services();
    await expect(uploadAttachment(uploadRequest(), sql, USER_ID, deps)).rejects.toThrow(
      'insert failed',
    );
    // The queued job later finds nothing to delete, which it treats as done.
    expect(deps.deleteBlob).toHaveBeenCalledWith(BLOB_URL);
  });
});

describe('DELETE /send/attachments/:id', () => {
  const url = (query = '') =>
    new URL(`https://cookie-web-send.example/send/attachments/${ATTACHMENT_ID}${query}`);

  it('rejects a malformed id without touching the database', async () => {
    const sql = createMockSql();
    const response = await deleteAttachment(sql, USER_ID, 'not-an-id', url());
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('rejects a malformed draftId', async () => {
    const sql = createMockSql();
    const response = await deleteAttachment(sql, USER_ID, ATTACHMENT_ID, url('?draftId=nope'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'draftId must be a valid id' });
    expect(sql).not.toHaveBeenCalled();
  });

  it('404s an id that is not the caller’s', async () => {
    const sql = createMockSql([[{ found: false, deleted: false }]]);
    const response = await deleteAttachment(sql, USER_ID, ATTACHMENT_ID, url());
    expect(response.status).toBe(404);
  });

  it('keeps an upload another draft or a pending scheduled send still references', async () => {
    const sql = createMockSql([[{ found: true, deleted: false }]]);
    const response = await deleteAttachment(sql, USER_ID, ATTACHMENT_ID, url());
    expect(response.status).toBe(409);
  });

  it('unlinks the caller draft and deletes an unreferenced upload', async () => {
    const sql = createMockSql([[{ found: true, deleted: true }]]);
    const response = await deleteAttachment(
      sql,
      USER_ID,
      ATTACHMENT_ID,
      url(`?draftId=${DRAFT_ID}`),
    );
    expect(response.status).toBe(204);
    expect(sql.calls[0].text).toContain('DELETE FROM draft_attachments');
    expect(sql.calls[0].values).toEqual([DRAFT_ID, USER_ID, ATTACHMENT_ID, ATTACHMENT_ID, USER_ID]);
  });

  it('passes a null draftId through when none is given', async () => {
    const sql = createMockSql([[{ found: true, deleted: true }]]);
    await deleteAttachment(sql, USER_ID, ATTACHMENT_ID, url());
    expect(sql.calls[0].values[0]).toBeNull();
  });
});

describe('handleAttachments routing', () => {
  const base = 'https://cookie-web-send.example/send/attachments';

  it('allows only POST on the collection', async () => {
    const request = new Request(base, { method: 'GET' });
    const response = await handleAttachments(
      request,
      new URL(base),
      undefined,
      createMockSql(),
      USER_ID,
      services(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('allows only DELETE on one upload', async () => {
    const request = new Request(`${base}/${ATTACHMENT_ID}`, { method: 'POST' });
    const response = await handleAttachments(
      request,
      new URL(`${base}/${ATTACHMENT_ID}`),
      ATTACHMENT_ID,
      createMockSql(),
      USER_ID,
      services(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('DELETE');
  });
});
