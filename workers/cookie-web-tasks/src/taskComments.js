import { readFormBody, bodyErrorResponse } from '../../../shared/read-body.js';
import { queueObjectCleanup } from './objectCleanup.js';
// Discussion threads on tasks (Cookie-Web migration 0096): one task_comments
// row per entry, in time order, holding text, an attached file, or both.
// An attachment's bytes go to the FILES R2 bucket under <user_id>/<uuid>,
// exactly as files.js stores Documents uploads; the row keeps the name,
// type and size and is the source of truth — an object without a row is a
// leak to clean up, never a file to serve. Only the author (user_id) may
// edit or delete an entry. Shaped after files.js: the same size caps, type
// sniffing, upload rate limit and write-object-then-row ordering.

import {
  FALLBACK_TYPE,
  INLINE_TYPES,
  MAX_FILE_BYTES,
  cleanMimeType,
  contentDisposition,
  sniffFileType,
} from './files.js';
import { cleanText } from './documents.js';
import { decodeCursor, encodeCursor, validId } from '../../../shared/pagination.js';

// Same as a task description (taskItems.js).
export const MAX_COMMENT_LENGTH = 10000;
const MAX_NAME_LENGTH = 255;
// Multipart framing around the file itself; a declared body past this is
// refused before a byte is read.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const COMMENT_RATE_LIMIT = { limit: 60, windowMs: 60_000 };
const PAGE_SIZE = 100;

const NEEDS_CONTENT = 'A comment needs text or an attachment';
// The cursor time exactly as the list query emits it (UTC, microseconds).
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;

/**
 * A cursor time the list query could have produced: the exact format, and
 * a real calendar date. Date.parse alone would admit 2026-02-31, which
 * Postgres refuses at the ::timestamptz cast — a 500 where the caller
 * deserves a 400.
 *
 * @param {any} value
 */
export function isCursorTime(value) {
  if (typeof value !== 'string' || !CURSOR_TIME_RE.test(value)) return false;
  const millis = `${value.slice(0, 23)}Z`;
  const date = new Date(millis);
  return !Number.isNaN(date.getTime()) && date.toISOString() === millis;
}

/**
 * @typedef {{
 *   allowRequest: (sql: import('postgres').Sql, userId: string, scope: string,
 *     policy: {limit: number, windowMs: number}) => Promise<boolean>,
 *   report?: (operation: string, error: unknown, extra: Record<string, unknown>) => void,
 * }} CommentDeps
 */

/** @param {any} row */
function publicRow({ cursor_time: _cursorTime, ...row }) {
  return row;
}

/**
 * GET /task-comments?task=<uuid>[&after=<cursor>] — the thread of one owned
 * task, oldest first, 100 per page.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 */
export async function getTaskComments(sql, userId, url) {
  const taskId = url.searchParams.get('task');
  if (!validId(taskId)) return Response.json({ error: 'Invalid task id' }, { status: 400 });
  let cursor;
  try {
    cursor = decodeCursor(
      url.searchParams.get('after'),
      (value) =>
        Array.isArray(value) && value.length === 2 && isCursorTime(value[0]) && validId(value[1]),
    );
  } catch {
    return Response.json({ error: 'Invalid comment cursor' }, { status: 400 });
  }
  // The join is the ownership check: a task the caller does not own reads
  // as an empty thread rather than a hint that it exists. One flat
  // parameterised query rather than composed fragments, for the reason
  // getTaskItems gives: the test mock counts a nested fragment as a call.
  const rows = await sql`
    SELECT c.id, c.task_id AS "taskId", c.body,
      CASE WHEN c.object_key IS NULL THEN NULL ELSE jsonb_build_object(
        'name', c.file_name, 'mimeType', c.mime_type, 'sizeBytes', c.size_bytes) END AS attachment,
      (c.user_id = ${userId}) AS mine,
      c.edited_at AS "editedAt", c.created_at AS "createdAt", c.updated_at AS "updatedAt",
      to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM task_comments c
    JOIN task_items t ON t.id = c.task_id AND t.user_id = ${userId}
    WHERE c.task_id = ${taskId}
      AND (${cursor === null}::boolean
        OR (c.created_at, c.id) > (${cursor?.[0] ?? null}::text::timestamptz, ${cursor?.[1] ?? null}::uuid))
    ORDER BY c.created_at, c.id
    LIMIT ${PAGE_SIZE + 1}
  `;
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return Response.json({
    comments: page.map(publicRow),
    nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor([last.cursor_time, last.id]) : null,
  });
}

/**
 * POST /task-comments — multipart/form-data with `task`, optional `body`
 * text and optional `file`; at least one of the two. The object is written
 * first; a failed row insert removes it again so nothing leaks.
 *
 * @param {Request} request
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{FILES?: R2Bucket}} env
 * @param {CommentDeps} deps
 */
export async function createTaskComment(request, sql, userId, env, deps) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) {
    return Response.json({ error: 'File is larger than 25 MB' }, { status: 413 });
  }
  if (!(await deps.allowRequest(sql, userId, 'task-comment', COMMENT_RATE_LIMIT))) {
    return Response.json({ error: 'Too many comments, slow down' }, { status: 429 });
  }

  let form;
  try {
    form = await readFormBody(request, {
      maxBytes: MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES,
      fields: ['task', 'body', 'file'],
    });
  } catch (error) {
    return (
      bodyErrorResponse(error) ??
      Response.json({ error: 'Invalid multipart body' }, { status: 400 })
    );
  }
  const taskField = form.get('task');
  const taskId = validId(taskField) ? String(taskField) : null;
  if (!taskId) return Response.json({ error: 'A valid task id is required' }, { status: 400 });
  const bodyField = form.get('body');
  const body = bodyField instanceof File ? null : cleanText(bodyField ?? '', MAX_COMMENT_LENGTH);
  if (body === null) return Response.json({ error: 'body must be text' }, { status: 400 });
  const file = form.get('file');
  if (file !== null && !(file instanceof File)) {
    return Response.json({ error: 'file must be a file' }, { status: 400 });
  }
  if (!body && !file) return Response.json({ error: NEEDS_CONTENT }, { status: 400 });
  if (file && !env.FILES) {
    return Response.json({ error: 'File storage is not configured' }, { status: 503 });
  }
  if (file && file.size > MAX_FILE_BYTES) {
    return Response.json({ error: 'File is larger than 25 MB' }, { status: 413 });
  }

  // Nothing is written to the bucket for a task the caller does not own.
  // The row insert below checks again under the lock; this read only spares
  // the upload.
  if (file) {
    const [task] = await sql`
      SELECT id FROM task_items WHERE id = ${taskId} AND user_id = ${userId}
    `;
    if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  /** @type {{file_name: string | null, mime_type: string | null, size_bytes: number | null, object_key: string | null}} */
  let attachment = { file_name: null, mime_type: null, size_bytes: null, object_key: null };
  if (file && env.FILES) {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return Response.json({ error: 'File is larger than 25 MB' }, { status: 413 });
    }
    const objectKey = `${userId}/${crypto.randomUUID()}`;
    const mimeType = sniffFileType(bytes) ?? cleanMimeType(file.type);
    attachment = {
      file_name: cleanText(file.name, MAX_NAME_LENGTH) || 'Untitled',
      mime_type: mimeType,
      size_bytes: bytes.byteLength,
      object_key: objectKey,
    };
    await queueObjectCleanup(sql, 'r2', objectKey, 24);
    await env.FILES.put(objectKey, bytes, { httpMetadata: { contentType: mimeType } });
  }

  // The row goes in under the owner's task lock, the one every cascading
  // delete (deleteTaskItem, deleteProject, the Todoist sync) snapshots
  // attachment keys under, so a comment is either in a delete's snapshot
  // or refused because its task is already gone — never a row that
  // cascades away with an object nobody knows about. The insert re-checks
  // the task itself: no owned task, no row.
  let comment;
  try {
    [comment] = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 1))`;
      return tx`
        INSERT INTO task_comments (task_id, user_id, body, file_name, mime_type, size_bytes, object_key)
        SELECT t.id, ${userId}, ${body}, ${attachment.file_name}, ${attachment.mime_type},
               ${attachment.size_bytes}, ${attachment.object_key}
        FROM task_items t WHERE t.id = ${taskId} AND t.user_id = ${userId}
        RETURNING id, task_id AS "taskId", body,
          CASE WHEN object_key IS NULL THEN NULL ELSE jsonb_build_object(
            'name', file_name, 'mimeType', mime_type, 'sizeBytes', size_bytes) END AS attachment,
          true AS mine, edited_at AS "editedAt", created_at AS "createdAt", updated_at AS "updatedAt"
      `;
    });
  } catch (error) {
    if (attachment.object_key) {
      await env.FILES?.delete(attachment.object_key).catch(() => undefined);
    }
    console.log(
      JSON.stringify({
        event: 'task_comment_rejected',
        message: /** @type {Error} */ (error).message,
      }),
    );
    return Response.json({ error: 'Failed to save the comment' }, { status: 500 });
  }
  if (!comment) {
    if (attachment.object_key) {
      await env.FILES?.delete(attachment.object_key).catch(() => undefined);
    }
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }
  console.log(
    JSON.stringify({
      event: 'task_comment_created',
      comment_id: comment.id,
      size: attachment.size_bytes ?? 0,
    }),
  );
  return Response.json({ comment }, { status: 201 });
}

/**
 * PATCH /task-comments/:id — { body?, attachment?: null }. Only the author
 * may edit; the text is replaced, and `attachment: null` drops the file
 * from an entry that still has text. The object goes after the row is
 * updated: the row is the source of truth, a leaked object is reported.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 * @param {any} body
 * @param {{FILES?: R2Bucket}} env
 * @param {Pick<CommentDeps, 'report'>} [deps]
 */
export async function updateTaskComment(sql, userId, id, body, env, deps = {}) {
  const hasBody = body !== null && typeof body === 'object' && Object.hasOwn(body, 'body');
  const dropsFile =
    body !== null &&
    typeof body === 'object' &&
    Object.hasOwn(body, 'attachment') &&
    body.attachment === null;
  if (!hasBody && !dropsFile) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 });
  }
  const text = hasBody ? cleanText(body.body ?? '', MAX_COMMENT_LENGTH) : null;
  if (hasBody && text === null) {
    return Response.json({ error: 'body must be text' }, { status: 400 });
  }

  const result = await sql.begin(async (tx) => {
    const [existing] = await tx`
      SELECT body, object_key FROM task_comments
      WHERE id = ${id} AND user_id = ${userId} FOR UPDATE
    `;
    if (!existing)
      return { response: Response.json({ error: 'Comment not found' }, { status: 404 }) };
    const nextBody = hasBody ? /** @type {string} */ (text) : existing.body;
    const keepsFile = existing.object_key !== null && !dropsFile;
    if (!nextBody && !keepsFile) {
      return { response: Response.json({ error: NEEDS_CONTENT }, { status: 400 }) };
    }
    const [comment] = await tx`
      UPDATE task_comments SET
        body = ${nextBody},
        file_name  = CASE WHEN ${dropsFile}::boolean THEN NULL ELSE file_name END,
        mime_type  = CASE WHEN ${dropsFile}::boolean THEN NULL ELSE mime_type END,
        size_bytes = CASE WHEN ${dropsFile}::boolean THEN NULL ELSE size_bytes END,
        object_key = CASE WHEN ${dropsFile}::boolean THEN NULL ELSE object_key END,
        edited_at = now(), updated_at = now()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id, task_id AS "taskId", body,
        CASE WHEN object_key IS NULL THEN NULL ELSE jsonb_build_object(
          'name', file_name, 'mimeType', mime_type, 'sizeBytes', size_bytes) END AS attachment,
        true AS mine, edited_at AS "editedAt", created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    return { comment, droppedKey: dropsFile ? existing.object_key : null };
  });
  if (result.response) return result.response;
  if (result.droppedKey)
    await deleteAttachmentObject(env, result.droppedKey, deps, { comment_id: id });
  return Response.json({ comment: result.comment });
}

/**
 * DELETE /task-comments/:id — the author's own entry: row first, then the
 * object.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 * @param {{FILES?: R2Bucket}} env
 * @param {Pick<CommentDeps, 'report'>} [deps]
 */
export async function deleteTaskComment(sql, userId, id, env, deps = {}) {
  const [deleted] = await sql`
    DELETE FROM task_comments WHERE id = ${id} AND user_id = ${userId} RETURNING object_key
  `;
  if (!deleted) return Response.json({ error: 'Comment not found' }, { status: 404 });
  if (deleted.object_key)
    await deleteAttachmentObject(env, deleted.object_key, deps, { comment_id: id });
  return new Response(null, { status: 204 });
}

/**
 * GET /task-comments/:id/attachment — the only way an attachment's bytes
 * leave the bucket. Readable by the task's owner, not only the author.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 * @param {{FILES?: R2Bucket}} env
 */
export async function getTaskCommentAttachment(sql, userId, id, env) {
  if (!env.FILES) {
    return Response.json({ error: 'File storage is not configured' }, { status: 503 });
  }
  const [row] = await sql`
    SELECT c.file_name, c.mime_type, c.object_key
    FROM task_comments c
    JOIN task_items t ON t.id = c.task_id AND t.user_id = ${userId}
    WHERE c.id = ${id} AND c.object_key IS NOT NULL
  `;
  if (!row) return Response.json({ error: 'Attachment not found' }, { status: 404 });
  const object = await env.FILES.get(row.object_key);
  if (!object) {
    console.log(JSON.stringify({ event: 'task_comment_object_missing', comment_id: id }));
    return Response.json({ error: 'Attachment not found' }, { status: 404 });
  }
  const mimeType = row.mime_type || FALLBACK_TYPE;
  return new Response(object.body, {
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(object.size),
      'Content-Disposition': contentDisposition(row.file_name, INLINE_TYPES.has(mimeType)),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * @param {{FILES?: R2Bucket}} env
 * @param {string} key
 * @param {Pick<CommentDeps, 'report'>} deps
 * @param {Record<string, unknown>} extra Named in the log and the report.
 */
async function deleteAttachmentObject(env, key, deps, extra) {
  try {
    await env.FILES?.delete(key);
  } catch (error) {
    console.log(JSON.stringify({ event: 'task_comment_object_delete_failed', ...extra }));
    deps.report?.('task_comment_object_delete', error, extra);
  }
}

// ---------------------------------------------------------------------------
// Cascades. task_comments.task_id cascades from task_items, so deleting a
// task, a project (whose tasks cascade) or a Todoist mirror takes the rows
// with it and the Worker never sees their object keys. Rather than teach
// every delete path the thread's shape, a caller snapshots the owner's
// attachment keys and runs the delete in one transaction under the owner's
// task lock (the lock createTaskComment inserts under, so no comment can
// slip in between), then asks after the commit which keys no longer have a
// row; those objects go. Both reads use the partial index on (user_id)
// WHERE object_key IS NOT NULL, and nothing is read back when the owner had
// no attachments to begin with.

/**
 * Every attachment key the owner holds right now.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
export async function attachmentKeysOf(sql, userId) {
  const rows = await sql`
    SELECT object_key FROM task_comments WHERE user_id = ${userId} AND object_key IS NOT NULL
  `;
  return rows.map((row) => String(row.object_key));
}

/**
 * Deletes the objects of the keys in `before` that no longer have a row.
 * Best effort: a failed object delete is reported, never surfaced, and the
 * rows stay the source of truth either way.
 *
 * @param {import('postgres').Sql} sql
 * @param {{FILES?: R2Bucket}} env
 * @param {string} userId
 * @param {string[]} before
 * @param {Pick<CommentDeps, 'report'>} [deps]
 * @returns {Promise<number>} How many objects were removed.
 */
export async function deleteVanishedAttachments(sql, env, userId, before, deps = {}) {
  if (!before.length || !env.FILES) return 0;
  const kept = new Set(await attachmentKeysOf(sql, userId));
  const gone = before.filter((key) => !kept.has(key));
  await Promise.all(gone.map((key) => deleteAttachmentObject(env, key, deps, { cascade: true })));
  if (gone.length) {
    console.log(JSON.stringify({ event: 'task_comment_attachments_cascaded', count: gone.length }));
  }
  return gone.length;
}
