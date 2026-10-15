import { describe, expect, it, vi } from 'vitest';
import { createMockSql } from './helpers.js';
import {
  attachmentKeysOf,
  createTaskComment,
  deleteTaskComment,
  deleteVanishedAttachments,
  getTaskCommentAttachment,
  getTaskComments,
  isCursorTime,
  updateTaskComment,
} from '../src/taskComments.js';
import { MAX_FILE_BYTES } from '../src/files.js';
import { encodeCursor } from '../../../shared/pagination.js';

const USER = '99999999-9999-9999-9999-999999999999';
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const COMMENT_ID = '22222222-2222-4222-8222-222222222222';
const ROW = {
  id: COMMENT_ID,
  taskId: TASK_ID,
  body: 'Looks good',
  attachment: null,
  mine: true,
  editedAt: null,
  createdAt: 't0',
  updatedAt: 't0',
};
const allow = { allowRequest: async () => true };

/** @returns {any} Shaped like the R2Bucket binding, loosely typed for stubbing. */
function r2() {
  return { put: vi.fn(async () => ({})), get: vi.fn(), delete: vi.fn(async () => undefined) };
}

/**
 * @param {{task?: string, body?: string, file?: {name: string, type: string, bytes: Uint8Array} | null, headers?: Record<string, string>}} [opts]
 */
function postRequest({ task = TASK_ID, body, file, headers } = {}) {
  const form = new FormData();
  form.set('task', task);
  if (body !== undefined) form.set('body', body);
  if (file) {
    const payload = new ArrayBuffer(file.bytes.byteLength);
    new Uint8Array(payload).set(file.bytes);
    form.set('file', new File([payload], file.name, { type: file.type }));
  }
  return new Request('https://cookie-web-tasks.example/task-comments', {
    method: 'POST',
    body: form,
    headers,
  });
}

describe('GET /task-comments', () => {
  it('lists a task thread oldest first, joined on the owner', async () => {
    const sql = createMockSql([[{ ...ROW, cursor_time: '2026-10-15T09:00:00.000000Z' }]]);
    const response = await getTaskComments(
      sql,
      USER,
      new URL(`https://x/task-comments?task=${TASK_ID}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ comments: [ROW], nextCursor: null });
    expect(sql.calls[0].text).toContain('JOIN task_items t ON t.id = c.task_id AND t.user_id = ?');
    expect(sql.calls[0].text).toContain('ORDER BY c.created_at, c.id');
    expect(sql.calls[0].values).toEqual(expect.arrayContaining([USER, TASK_ID]));
  });

  it('pages past a hundred entries with a cursor', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({
      ...ROW,
      id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      cursor_time: `2026-10-15T09:00:${String(i % 60).padStart(2, '0')}.000000Z`,
    }));
    const sql = createMockSql([rows]);
    const response = await getTaskComments(
      sql,
      USER,
      new URL(`https://x/task-comments?task=${TASK_ID}`),
    );
    const { comments, nextCursor } = await response.json();

    expect(comments).toHaveLength(100);
    expect(comments[0].cursor_time).toBeUndefined();
    expect(nextCursor).toEqual(expect.any(String));

    const again = createMockSql([[]]);
    await getTaskComments(
      again,
      USER,
      new URL(`https://x/task-comments?task=${TASK_ID}&after=${nextCursor}`),
    );
    expect(again.calls[0].text).toContain('OR (c.created_at, c.id) >');
    expect(again.calls[0].values).toContain(false);
    expect(again.calls[0].values).toContain(rows[99].id);
    // Without a cursor the comparison is switched off and its values are null.
    expect(sql.calls[0].values).toEqual([USER, USER, TASK_ID, true, null, null, 101]);
  });

  it('rejects a cursor whose time is not a real calendar date', async () => {
    const impossible = encodeCursor(['2026-02-31T09:00:00.000000Z', COMMENT_ID]);
    const sql = createMockSql();
    const response = await getTaskComments(
      sql,
      USER,
      new URL(`https://x/task-comments?task=${TASK_ID}&after=${impossible}`),
    );
    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
    expect(isCursorTime('2026-10-15T09:00:00.000000Z')).toBe(true);
    expect(isCursorTime('2026-10-15T09:00:00Z')).toBe(false);
  });

  it('rejects a malformed task id or cursor', async () => {
    expect(
      (await getTaskComments(createMockSql(), USER, new URL('https://x/task-comments?task=nope')))
        .status,
    ).toBe(400);
    expect(
      (
        await getTaskComments(
          createMockSql(),
          USER,
          new URL(`https://x/task-comments?task=${TASK_ID}&after=!!`),
        )
      ).status,
    ).toBe(400);
  });
});

describe('POST /task-comments', () => {
  it('saves a text comment without touching the bucket', async () => {
    const env = { FILES: r2() };
    const sql = createMockSql([[ROW]]);
    const response = await createTaskComment(
      postRequest({ body: '  Looks good ' }),
      sql,
      USER,
      env,
      allow,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ comment: ROW });
    expect(env.FILES.put).not.toHaveBeenCalled();
    // One statement under the owner's task lock: the insert itself checks
    // the task is the caller's.
    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(sql.controlCalls[0].text).toContain('pg_advisory_xact_lock');
    expect(sql.calls).toHaveLength(1);
    expect(sql.calls[0].text).toContain('INSERT INTO task_comments');
    expect(sql.calls[0].text).toContain('FROM task_items t WHERE t.id = ? AND t.user_id = ?');
    expect(sql.calls[0].values).toEqual([
      USER,
      'Looks good',
      null,
      null,
      null,
      null,
      TASK_ID,
      USER,
    ]);
  });

  it('404s a text comment on a task the caller does not own', async () => {
    const sql = createMockSql([[]]);
    const response = await createTaskComment(
      postRequest({ body: 'x' }),
      sql,
      USER,
      { FILES: r2() },
      allow,
    );
    expect(response.status).toBe(404);
  });

  it('writes the object then the row for an attachment, sniffing its type', async () => {
    const env = { FILES: r2() };
    const stored = {
      ...ROW,
      body: '',
      attachment: { name: 'shot.png', mimeType: 'image/png', sizeBytes: 10 },
    };
    const sql = createMockSql([[{ id: TASK_ID }], [stored]]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const response = await createTaskComment(
      postRequest({ file: { name: 'shot.png', type: 'text/plain', bytes: png } }),
      sql,
      USER,
      env,
      allow,
    );

    expect(response.status).toBe(201);
    expect((await response.json()).comment.attachment.name).toBe('shot.png');
    expect(env.FILES.put).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${USER}/[0-9a-f-]{36}$`)),
      expect.any(ArrayBuffer),
      { httpMetadata: { contentType: 'image/png' } },
    );
    expect(sql.calls[0].text).toContain('SELECT id FROM task_items WHERE id = ? AND user_id = ?');
    expect(sql.calls[1].values).toEqual([
      USER,
      '',
      'shot.png',
      'image/png',
      10,
      env.FILES.put.mock.calls[0][0],
      TASK_ID,
      USER,
    ]);
  });

  it('removes the object again when the task vanished before the locked insert', async () => {
    const env = { FILES: r2() };
    const sql = createMockSql([[{ id: TASK_ID }], []]);
    const response = await createTaskComment(
      postRequest({ file: { name: 'a.bin', type: '', bytes: new Uint8Array([1, 2]) } }),
      sql,
      USER,
      env,
      allow,
    );

    expect(response.status).toBe(404);
    expect(env.FILES.put).toHaveBeenCalledTimes(1);
    expect(env.FILES.delete).toHaveBeenCalledWith(env.FILES.put.mock.calls[0][0]);
  });

  it('removes the object again when the row insert fails', async () => {
    const env = { FILES: r2() };
    const sql = createMockSql();
    sql.mockImplementationOnce(() => Promise.resolve([{ id: TASK_ID }]));
    sql.mockImplementationOnce(() => Promise.reject(new Error('insert failed')));
    const response = await createTaskComment(
      postRequest({ body: 'x', file: { name: 'a.bin', type: '', bytes: new Uint8Array([1, 2]) } }),
      sql,
      USER,
      env,
      allow,
    );

    expect(response.status).toBe(500);
    expect(env.FILES.delete).toHaveBeenCalledWith(env.FILES.put.mock.calls[0][0]);
  });

  it('refuses an entry with neither text nor a file', async () => {
    const env = { FILES: r2() };
    const sql = createMockSql();
    const response = await createTaskComment(postRequest({ body: '   ' }), sql, USER, env, allow);
    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('404s a task the caller does not own, before writing anything', async () => {
    const env = { FILES: r2() };
    const sql = createMockSql([[]]);
    const response = await createTaskComment(
      postRequest({ body: 'x', file: { name: 'a.bin', type: '', bytes: new Uint8Array([1]) } }),
      sql,
      USER,
      env,
      allow,
    );
    expect(response.status).toBe(404);
    expect(env.FILES.put).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared body before reading it', async () => {
    const request = new Request('https://x/task-comments', {
      method: 'POST',
      headers: { 'Content-Length': String(MAX_FILE_BYTES + 1_000_000) },
      body: 'x',
    });
    const response = await createTaskComment(
      request,
      createMockSql(),
      USER,
      { FILES: r2() },
      allow,
    );
    expect(response.status).toBe(413);
  });

  it('rejects an oversized file after reading it', async () => {
    const env = { FILES: r2() };
    const response = await createTaskComment(
      postRequest({
        file: { name: 'big.bin', type: '', bytes: new Uint8Array(MAX_FILE_BYTES + 1) },
      }),
      createMockSql([[{ id: TASK_ID }]]),
      USER,
      env,
      allow,
    );
    expect(response.status).toBe(413);
    expect(env.FILES.put).not.toHaveBeenCalled();
  });

  it('answers 503 for a file when storage is not configured, and 429 when rate limited', async () => {
    const noBucket = await createTaskComment(
      postRequest({ file: { name: 'a.bin', type: '', bytes: new Uint8Array([1]) } }),
      createMockSql(),
      USER,
      {},
      allow,
    );
    expect(noBucket.status).toBe(503);

    const limited = await createTaskComment(
      postRequest({ body: 'x' }),
      createMockSql(),
      USER,
      {},
      {
        allowRequest: async () => false,
      },
    );
    expect(limited.status).toBe(429);
  });

  it('rejects a non-multipart body and a malformed task id', async () => {
    const json = new Request('https://x/task-comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect((await createTaskComment(json, createMockSql(), USER, {}, allow)).status).toBe(400);
    expect(
      (
        await createTaskComment(
          postRequest({ task: 'nope', body: 'x' }),
          createMockSql(),
          USER,
          {},
          allow,
        )
      ).status,
    ).toBe(400);
  });
});

describe('PATCH /task-comments/:id', () => {
  it('replaces the text of the author own entry and stamps edited_at', async () => {
    const env = { FILES: r2() };
    const sql = createMockSql([[{ body: 'Old', object_key: null }], [{ ...ROW, body: 'New' }]]);
    const response = await updateTaskComment(sql, USER, COMMENT_ID, { body: ' New ' }, env);

    expect(response.status).toBe(200);
    expect((await response.json()).comment.body).toBe('New');
    expect(sql.calls[0].text).toContain('FOR UPDATE');
    expect(sql.calls[0].values).toEqual([COMMENT_ID, USER]);
    expect(sql.calls[1].text).toContain('edited_at = now()');
    expect(sql.calls[1].values[0]).toBe('New');
    expect(env.FILES.delete).not.toHaveBeenCalled();
  });

  it('drops the attachment and removes its object after the row is updated', async () => {
    const env = { FILES: r2() };
    const sql = createMockSql([[{ body: 'Keep', object_key: 'u/k' }], [ROW]]);
    const response = await updateTaskComment(sql, USER, COMMENT_ID, { attachment: null }, env);

    expect(response.status).toBe(200);
    expect(sql.calls[1].values[1]).toBe(true);
    expect(env.FILES.delete).toHaveBeenCalledWith('u/k');
  });

  it('refuses to leave an entry with neither text nor a file', async () => {
    const sql = createMockSql([[{ body: 'Only text', object_key: null }]]);
    const emptied = await updateTaskComment(sql, USER, COMMENT_ID, { body: '' }, {});
    expect(emptied.status).toBe(400);
    expect(sql.calls).toHaveLength(1);

    const fileOnly = createMockSql([[{ body: '', object_key: 'u/k' }]]);
    const dropped = await updateTaskComment(fileOnly, USER, COMMENT_ID, { attachment: null }, {});
    expect(dropped.status).toBe(400);
  });

  it('404s an entry the caller did not write, and 400s an empty change', async () => {
    expect(
      (await updateTaskComment(createMockSql([[]]), USER, COMMENT_ID, { body: 'x' }, {})).status,
    ).toBe(404);
    expect((await updateTaskComment(createMockSql(), USER, COMMENT_ID, {}, {})).status).toBe(400);
    expect(
      (await updateTaskComment(createMockSql(), USER, COMMENT_ID, { body: 5 }, {})).status,
    ).toBe(400);
  });
});

describe('DELETE /task-comments/:id', () => {
  it('deletes the row then the object', async () => {
    const env = { FILES: r2() };
    const sql = createMockSql([[{ object_key: 'u/k' }]]);
    const response = await deleteTaskComment(sql, USER, COMMENT_ID, env);

    expect(response.status).toBe(204);
    expect(sql.calls[0].text).toContain('DELETE FROM task_comments WHERE id = ? AND user_id = ?');
    expect(env.FILES.delete).toHaveBeenCalledWith('u/k');
  });

  it('reports a failed object delete rather than surfacing it', async () => {
    const env = { FILES: r2() };
    env.FILES.delete.mockRejectedValueOnce(new Error('r2 down'));
    const report = vi.fn();
    const response = await deleteTaskComment(
      createMockSql([[{ object_key: 'u/k' }]]),
      USER,
      COMMENT_ID,
      env,
      { report },
    );
    expect(response.status).toBe(204);
    expect(report).toHaveBeenCalledWith('task_comment_object_delete', expect.any(Error), {
      comment_id: COMMENT_ID,
    });
  });

  it('404s an entry the caller did not write', async () => {
    const response = await deleteTaskComment(createMockSql([[]]), USER, COMMENT_ID, {});
    expect(response.status).toBe(404);
  });
});

describe('GET /task-comments/:id/attachment', () => {
  it('streams the object with its disposition, inline only for a sniffed type', async () => {
    const env = { FILES: r2() };
    env.FILES.get.mockResolvedValue({ body: 'bytes', size: 5 });
    const sql = createMockSql([
      [{ file_name: 'shot.png', mime_type: 'image/png', object_key: 'u/k' }],
    ]);
    const response = await getTaskCommentAttachment(sql, USER, COMMENT_ID, env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Disposition')).toContain('inline; filename="shot.png"');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(sql.calls[0].text).toContain('JOIN task_items t ON t.id = c.task_id AND t.user_id = ?');
    expect(env.FILES.get).toHaveBeenCalledWith('u/k');

    const zip = createMockSql([
      [{ file_name: 'a.zip', mime_type: 'application/zip', object_key: 'u/z' }],
    ]);
    const download = await getTaskCommentAttachment(zip, USER, COMMENT_ID, env);
    expect(download.headers.get('Content-Disposition')).toContain('attachment; filename="a.zip"');
  });

  it('404s when the row or the object is missing, 503 without a bucket', async () => {
    const env = { FILES: r2() };
    expect(
      (await getTaskCommentAttachment(createMockSql([[]]), USER, COMMENT_ID, env)).status,
    ).toBe(404);
    env.FILES.get.mockResolvedValue(null);
    expect(
      (
        await getTaskCommentAttachment(
          createMockSql([[{ file_name: 'a', mime_type: 'text/plain', object_key: 'u/k' }]]),
          USER,
          COMMENT_ID,
          env,
        )
      ).status,
    ).toBe(404);
    expect((await getTaskCommentAttachment(createMockSql(), USER, COMMENT_ID, {})).status).toBe(
      503,
    );
  });
});

describe('cascaded attachments', () => {
  it('lists the owner keys and removes the ones that lost their row', async () => {
    const sql = createMockSql([
      [{ object_key: 'u/a' }, { object_key: 'u/b' }],
      [{ object_key: 'u/b' }],
    ]);
    const env = { FILES: r2() };
    const before = await attachmentKeysOf(sql, USER);
    expect(before).toEqual(['u/a', 'u/b']);
    expect(sql.calls[0].text).toContain('WHERE user_id = ? AND object_key IS NOT NULL');

    const removed = await deleteVanishedAttachments(sql, env, USER, before);
    expect(removed).toBe(1);
    expect(env.FILES.delete).toHaveBeenCalledTimes(1);
    expect(env.FILES.delete).toHaveBeenCalledWith('u/a');
  });

  it('reads nothing back when there were no keys, or no bucket', async () => {
    const sql = createMockSql();
    expect(await deleteVanishedAttachments(sql, { FILES: r2() }, USER, [])).toBe(0);
    expect(await deleteVanishedAttachments(sql, {}, USER, ['u/a'])).toBe(0);
    expect(sql.calls).toHaveLength(0);
  });
});
