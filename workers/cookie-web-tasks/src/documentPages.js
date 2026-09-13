import { decodeCursor, encodeCursor, validId, validTimestamp } from '../../../shared/pagination.js';

/** @param {import('postgres').Sql} sql @param {string} userId @param {URL} url */
export async function getDocumentMetadata(sql, userId, url) {
  // Folders and global tag counts are navigation metadata, never inferred
  // from the currently loaded page of documents.
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const [revision] =
      await tx`SELECT revision::text FROM document_workspace_revisions WHERE user_id = ${userId}`;
    const version = revision?.revision ?? '0';
    if (url.searchParams.get('version') === version)
      return Response.json({ unchanged: true, version });
    const folders = await tx`SELECT id, parent_id, title, emoji, created_at
      FROM document_folders WHERE user_id = ${userId} ORDER BY title, created_at, id`;
    const tags = await tx`SELECT tag AS name, count(*)::int AS count FROM documents,
      LATERAL unnest(tags) AS tag WHERE user_id = ${userId} GROUP BY tag ORDER BY tag`;
    const [counts] =
      await tx`SELECT count(*)::int AS total, count(*) FILTER (WHERE starred)::int AS starred
      FROM documents WHERE user_id = ${userId}`;
    return Response.json({ folders, tags, counts, version });
  });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {URL} url */
export async function getDocumentPage(sql, userId, url) {
  const folder = url.searchParams.get('folder');
  const starred = url.searchParams.get('starred') === '1';
  const tag = url.searchParams.get('tag');
  if ((folder && folder !== 'root' && !validId(folder)) || (tag && tag.length > 100)) {
    return Response.json({ error: 'Invalid document filter' }, { status: 400 });
  }
  let cursor;
  try {
    cursor = decodeCursor(
      url.searchParams.get('before'),
      (value) =>
        Array.isArray(value) && value.length === 2 && validTimestamp(value[0]) && validId(value[1]),
    );
  } catch {
    return Response.json({ error: 'Invalid document cursor' }, { status: 400 });
  }
  const rows = await sql`
    SELECT id, folder_id, title, emoji, starred, tags, created_at, updated_at,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM documents WHERE user_id = ${userId}
      ${folder === 'root' ? sql`AND folder_id IS NULL` : folder ? sql`AND folder_id = ${folder}::uuid` : sql``}
      ${starred ? sql`AND starred` : sql``}
      ${tag ? sql`AND tags @> ARRAY[${tag}]::text[]` : sql``}
      ${cursor ? sql`AND (updated_at, id) < (${cursor[0]}::text::timestamptz, ${cursor[1]}::uuid)` : sql``}
    ORDER BY updated_at DESC, id DESC LIMIT 101
  `;
  const last = rows.slice(0, 100).at(-1);
  const documents = rows.slice(0, 100).map(({ cursor_time: _cursorTime, ...row }) => row);
  return Response.json({
    documents,
    nextCursor: rows.length > 100 && last ? encodeCursor([last.cursor_time, last.id]) : null,
  });
}
