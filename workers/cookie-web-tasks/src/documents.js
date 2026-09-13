import { getDocumentMetadata, getDocumentPage } from './documentPages.js';
// Ported from Cookie-Web's api/_lib/documents.js. Behaviorally identical
// (same queries, same validation, same response shapes/status codes) —
// only the (req, res) mutation style becomes returning a Response, and
// the Meilisearch search dependency is passed in explicitly (`deps`) rather
// than pulled from a services object or process.env.
//
// Was reached via GET/POST/PATCH/DELETE /api/tasks?resource=documents in
// Cookie-Web's Vercel deployment, purely to stay under Vercel Hobby's
// 12-function cap. This Worker has no such limit, so it's its own clean
// /documents route — but keeps the *internal* dispatch (id/templateId/
// templates/q query params on GET, body.kind on POST/PATCH/DELETE)
// unchanged: that logic is proven correct, and this is already the largest,
// highest-risk port in the migration.

import { DOCUMENTS_INDEX } from '../../../shared/meili/documents.js';
import { normalizeDocumentTags } from './documentTags.js';
import { resolveDailyNoteEventDate, syncDailyNoteEvents } from './dailyEventSync.js';
import { removeDocumentFromMeili, syncDocumentToMeili } from './documentMeiliSync.js';
import { flattenBlocksToText } from './documentText.js';
import { parseDocumentSearchQuery } from './queryParse.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_TITLE_LENGTH = 300;
export const MAX_EMOJI_LENGTH = 16;
// Blocks are stored verbatim, including base64 images, so the cap is generous
// but still bounds a single row (and request) to something sane.
export const MAX_BLOCKS_BYTES = 4 * 1024 * 1024;

const MAX_SEARCH_QUERY_CHARS = 500;
const SEARCH_RESULTS = 20;

/**
 * @typedef {{
 *   env: any,
 *   hybridSearch: (env: any, descriptor: any, query: {userId: string, text?: string, filter?: string, limit: number, semanticRatio?: number, sort?: string[]}, client?: any) => Promise<{id: string}[]>,
 * }} DocumentsDeps
 */

// UUID_RE.test coerces its argument; the identity check keeps non-strings
// that could coerce into a valid-looking id out of the raw SQL bindings.
/** @param {any} value */
function isUuid(value) {
  return value === String(value ?? '') && UUID_RE.test(value);
}

// Titles and emoji come straight from contenteditable inputs; bound them
// rather than trusting the client. Returns null when not a string at all.
/** @param {any} value @param {number} max */
export function cleanText(value, max) {
  if (!(value?.trim instanceof Function)) return null;
  return value.trim().slice(0, max);
}

// A document body must be an array of objects small enough to store. Returns
// null on anything else so the caller can 400 instead of persisting garbage.
/** @param {any} input */
export function normalizeBlocks(input) {
  if (!Array.isArray(input)) return null;
  if (input.some((block) => Object(block) !== block)) return null;
  if (JSON.stringify(input).length > MAX_BLOCKS_BYTES) return null;
  return input;
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export function fetchWorkspace(sql, userId) {
  return Promise.all([
    sql`
      SELECT f.id, f.parent_id, f.title, f.emoji, f.created_at
      FROM document_folders f
      WHERE f.user_id = ${userId}
      ORDER BY f.title ASC, f.created_at ASC
    `,
    sql`
      SELECT d.id, d.folder_id, d.title, d.emoji, d.starred, d.tags, d.created_at, d.updated_at
      FROM documents d
      WHERE d.user_id = ${userId}
      ORDER BY d.updated_at DESC
    `,
  ]);
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {string} id */
export function fetchDocument(sql, userId, id) {
  return sql`
    SELECT d.id, d.folder_id, d.title, d.emoji, d.starred, d.tags, d.blocks,
           d.created_at, d.updated_at
    FROM documents d
    WHERE d.id = ${id} AND d.user_id = ${userId}
  `;
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export function fetchTemplates(sql, userId) {
  return sql`
    SELECT t.id, t.title, t.emoji, t.created_at, t.updated_at
    FROM document_templates t
    WHERE t.user_id = ${userId}
    ORDER BY t.updated_at DESC
  `;
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {string} id */
export function fetchTemplate(sql, userId, id) {
  return sql`
    SELECT t.id, t.title, t.emoji, t.blocks, t.created_at, t.updated_at
    FROM document_templates t
    WHERE t.id = ${id} AND t.user_id = ${userId}
  `;
}

// Fetches the Meilisearch result ids in one list-shaped query, matching
// fetchWorkspace's row shape — blocks are never loaded for a result list, the
// same rule every other document list endpoint follows.
/** @param {import('postgres').Sql} sql @param {string} userId @param {string[]} ids */
function fetchSearchDocuments(sql, userId, ids) {
  return sql`
    SELECT d.id, d.folder_id, d.title, d.emoji, d.starred, d.tags, d.created_at, d.updated_at
    FROM documents d
    WHERE d.user_id = ${userId} AND d.id = ANY(${ids}::uuid[])
  `;
}

// content_text for a document's current title/blocks. Meilisearch indexes
// this field directly for keyword matching and generates the semantic vector
// itself (via its own openAI embedder, see shared/meili/embedder.js) once the
// document is synced — this Worker no longer computes or stores an embedding.
/**
 * @param {string} title
 * @param {any[]} blocks
 */
function computeSearchFields(title, blocks) {
  return { content_text: flattenBlocksToText(title, blocks) };
}

/** @param {import('postgres').Sql} sql @param {string} userId */
function userExists(sql, userId) {
  return sql`SELECT 1 FROM users WHERE id = ${userId}`;
}

// The caller's own folder, used to validate parent/target folder references
// before writing them — a folder id belonging to another user must behave
// exactly like one that does not exist.
/** @param {import('postgres').Sql} sql @param {string} userId @param {string} id */
function fetchOwnedFolder(sql, userId, id) {
  return sql`
    SELECT f.id
    FROM document_folders f
    WHERE f.id = ${id} AND f.user_id = ${userId}
  `;
}

/**
 * GET /documents — { folders, documents } (no blocks) by default;
 * ?id=<uuid> for a single document with blocks; ?templates / ?templateId=
 * for the template list/single template; ?q=… dispatches to search.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 * @param {DocumentsDeps} deps
 */
export async function getDocuments(sql, userId, url, deps) {
  if (url.searchParams.get('view') === 'meta') return getDocumentMetadata(sql, userId, url);
  if (url.searchParams.get('view') === 'page') return getDocumentPage(sql, userId, url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q) return searchDocuments(sql, userId, url, q, deps);

  const templateId = url.searchParams.get('templateId');
  if (templateId) {
    if (!isUuid(templateId)) {
      return Response.json({ error: 'A valid template id is required' }, { status: 400 });
    }
    const [template] = await fetchTemplate(sql, userId, templateId);
    if (!template) return Response.json({ error: 'Template not found' }, { status: 404 });
    return Response.json({ template });
  }

  if (url.searchParams.has('templates')) {
    const templates = await fetchTemplates(sql, userId);
    return Response.json({ templates });
  }

  const id = url.searchParams.get('id');
  if (id) {
    if (!isUuid(id))
      return Response.json({ error: 'A valid document id is required' }, { status: 400 });
    const [document] = await fetchDocument(sql, userId, id);
    if (!document) return Response.json({ error: 'Document not found' }, { status: 404 });
    return Response.json({ document });
  }

  const [folders, documents] = await fetchWorkspace(sql, userId);
  return Response.json({ folders, documents });
}

// GET /documents?q=…[&mode=keyword] — hybrid (keyword + semantic) search over
// the caller's documents, served by Meilisearch. mode=keyword is the
// lower-latency type-ahead path and skips embeddings. Response shape matches
// the workspace list (no blocks).
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 * @param {string} rawQuery
 * @param {DocumentsDeps} deps
 */
async function searchDocuments(sql, userId, url, rawQuery, deps) {
  if (rawQuery.length > MAX_SEARCH_QUERY_CHARS) {
    return Response.json({ error: 'q is required (max 500 chars)' }, { status: 400 });
  }

  // Split the raw query into free text, a prefix tsquery, and structured
  // operators (tag:/is:starred). A query containing only empty recognized
  // operators has no work to do and must not spend AI quota.
  const spec = parseDocumentSearchQuery(rawQuery);
  const hasFilters = Object.keys(spec.filters).length > 0;
  if (!spec.text && !hasFilters) {
    return Response.json({ documents: [] });
  }

  const semantic = url.searchParams.get('mode') !== 'keyword';

  return await searchViaMeili(sql, userId, spec, semantic, deps);
}

// Hydrates a Meilisearch id list into full document rows (in id order) and
// wraps them in the search response shape.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string[]} ids
 */
async function respondWithDocuments(sql, userId, ids) {
  if (ids.length === 0) return Response.json({ documents: [] });

  const rows = await fetchSearchDocuments(sql, userId, ids);
  const byId = new Map(rows.map((/** @type {any} */ row) => [row.id, row]));
  const documents = ids.map((id) => byId.get(id)).filter(Boolean);

  return Response.json({ documents });
}

/**
 * Structured filters as a Meilisearch expression. user_id is added by
 * hybridSearch itself, so it is deliberately absent here.
 *
 * @param {{tag?: string, starred?: boolean}} filters
 */
function meiliFilter(filters) {
  const parts = [];
  if (filters.tag) parts.push(`tags = '${filters.tag.replace(/[\\']/g, '\\$&')}'`);
  if (filters.starred) parts.push('starred = true');
  return parts.join(' AND ') || undefined;
}

// Document search. hits carry only ids (attributesToRetrieve inside
// hybridSearch), so the rows still come from Postgres via
// respondWithDocuments.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{text: string, filters: {tag?: string, starred?: boolean}}} spec
 * @param {boolean} semantic false when mode=keyword — forces keyword-only
 *   (semanticRatio 0) so type-ahead never spends an embedding call.
 * @param {DocumentsDeps} deps
 */
async function searchViaMeili(sql, userId, spec, semantic, deps) {
  let hits;
  try {
    hits = await deps.hybridSearch(deps.env, DOCUMENTS_INDEX, {
      userId,
      text: spec.text ?? '',
      filter: meiliFilter(spec.filters),
      limit: SEARCH_RESULTS,
      // mode=keyword maps to semanticRatio 0 — Meilisearch's keyword-only
      // setting, matching the old Postgres keyword leg. Omitting the key
      // entirely (rather than sending semanticRatio: undefined) lets
      // hybridSearch fall back to the index descriptor's default ratio.
      ...(semantic ? {} : { semanticRatio: 0 }),
      // No free text means no relevance signal, so fall back to newest-first
      // — what the recency leg did. DOCUMENTS_INDEX stores updated_at in
      // milliseconds, unlike the messages index (seconds).
      ...(spec.text ? {} : { sort: ['updated_at:desc'] }),
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'document_search_meili_failed',
        message: /** @type {Error} */ (error).message,
      }),
    );
    return Response.json({ error: 'Search is unavailable' }, { status: 503 });
  }

  const ids = hits.map((hit) => hit.id);
  return await respondWithDocuments(sql, userId, ids);
}

/**
 * POST /documents — creates a folder, document, or template depending on
 * body.kind.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {DocumentsDeps} deps
 * @param {any} env
 */
export async function createDocument(sql, userId, body, deps, env = {}) {
  const [user] = await userExists(sql, userId);
  if (!user) return Response.json({ error: 'User not found' }, { status: 404 });

  if (body.kind === 'folder') {
    const title = cleanText(body.title, MAX_TITLE_LENGTH);
    if (!title) return Response.json({ error: 'A folder title is required' }, { status: 400 });
    const parentId = body.parentId ?? null;
    if (parentId !== null) {
      if (!isUuid(parentId) || !(await fetchOwnedFolder(sql, userId, parentId)).length) {
        return Response.json({ error: 'parentId must be one of your folders' }, { status: 400 });
      }
    }
    const emoji = cleanText(body.emoji, MAX_EMOJI_LENGTH) || '📁';
    const [folder] = await sql`
      INSERT INTO document_folders (user_id, parent_id, title, emoji)
      VALUES (${userId}, ${parentId}, ${title}, ${emoji})
      RETURNING id, parent_id, title, emoji, created_at
    `;
    return Response.json({ folder }, { status: 201 });
  }

  if (body.kind === 'template') {
    const title = cleanText(body.title, MAX_TITLE_LENGTH);
    const blocks = normalizeBlocks(body.blocks ?? []);
    if (!title || !blocks) {
      return Response.json(
        { error: 'A template title and valid blocks are required' },
        { status: 400 },
      );
    }
    const emoji = cleanText(body.emoji, MAX_EMOJI_LENGTH) || '📄';
    const [template] = await sql`
      INSERT INTO document_templates (user_id, title, emoji, blocks)
      VALUES (${userId}, ${title}, ${emoji}, ${sql.json(blocks)})
      RETURNING id, title, emoji, blocks, created_at, updated_at
    `;
    return Response.json({ template }, { status: 201 });
  }

  if (body.kind === 'document') {
    const folderId = body.folderId ?? null;
    if (folderId !== null) {
      if (!isUuid(folderId) || !(await fetchOwnedFolder(sql, userId, folderId)).length) {
        return Response.json({ error: 'folderId must be one of your folders' }, { status: 400 });
      }
    }
    /** @type {any} */
    let template = null;
    if (body.templateId !== undefined && body.templateId !== null) {
      if (!isUuid(body.templateId)) {
        return Response.json(
          { error: 'templateId must be one of your templates' },
          { status: 400 },
        );
      }
      [template] = await fetchTemplate(sql, userId, body.templateId);
      if (!template) {
        return Response.json(
          { error: 'templateId must be one of your templates' },
          { status: 400 },
        );
      }
    }
    const title = cleanText(body.title, MAX_TITLE_LENGTH) ?? template?.title ?? '';
    const emoji = template?.emoji ?? '🔹';
    const blocks = template?.blocks ?? [];
    const searchFields = computeSearchFields(title, blocks);
    const [document] = await sql`
      INSERT INTO documents (user_id, folder_id, title, emoji, blocks, content_text)
      VALUES (${userId}, ${folderId}, ${title}, ${emoji}, ${sql.json(blocks)}, ${searchFields.content_text})
      RETURNING id, folder_id, title, emoji, starred, tags, blocks, created_at, updated_at
    `;
    // Best-effort; already swallows its own errors, so this never risks the
    // response over a search-indexing problem. A miss is caught by the
    // drift-repair sweep (search_indexed_at, added in a later task).
    await syncDocumentToMeili(sql, env, document.id);
    return Response.json({ document }, { status: 201 });
  }

  return Response.json(
    { error: "kind must be 'folder', 'document', or 'template'" },
    { status: 400 },
  );
}

/**
 * PATCH /documents — updates a folder/template (with body.kind set) or a
 * document (default).
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {DocumentsDeps} deps
 * @param {any} env
 */
export async function updateDocument(sql, userId, body, deps, env = {}) {
  if (!isUuid(body.id)) return Response.json({ error: 'A valid id is required' }, { status: 400 });

  if (body.kind === 'folder') {
    const title = cleanText(body.title, MAX_TITLE_LENGTH);
    if (!title) return Response.json({ error: 'A folder title is required' }, { status: 400 });
    const [folder] = await sql`
      UPDATE document_folders f
      SET title = ${title}
      WHERE f.id = ${body.id} AND f.user_id = ${userId}
      RETURNING f.id, f.parent_id, f.title, f.emoji, f.created_at
    `;
    if (!folder) return Response.json({ error: 'Folder not found' }, { status: 404 });
    return Response.json({ folder });
  }

  if (body.kind === 'template') {
    const title = cleanText(body.title, MAX_TITLE_LENGTH);
    const blocks = normalizeBlocks(body.blocks);
    if (!title || !blocks) {
      return Response.json(
        { error: 'A template title and valid blocks are required' },
        { status: 400 },
      );
    }
    const [template] = await sql`
      UPDATE document_templates t
      SET title = ${title}, blocks = ${sql.json(blocks)}, updated_at = now()
      WHERE t.id = ${body.id} AND t.user_id = ${userId}
      RETURNING t.id, t.title, t.emoji, t.blocks, t.created_at, t.updated_at
    `;
    if (!template) return Response.json({ error: 'Template not found' }, { status: 404 });
    return Response.json({ template });
  }

  // Document update: only the provided fields change. Every write bumps
  // updated_at, which is what orders the sidebar and dashboard.
  /** @type {Record<string, any>} */
  const updates = {};
  /** @type {any[] | null} */
  let newBlocks = null;
  if (Object.hasOwn(body, 'title')) {
    const title = cleanText(body.title, MAX_TITLE_LENGTH);
    if (title === null) return Response.json({ error: 'title must be a string' }, { status: 400 });
    updates.title = title;
  }
  if (Object.hasOwn(body, 'emoji')) {
    const emoji = cleanText(body.emoji, MAX_EMOJI_LENGTH);
    if (!emoji)
      return Response.json({ error: 'emoji must be a non-empty string' }, { status: 400 });
    updates.emoji = emoji;
  }
  if (Object.hasOwn(body, 'starred')) {
    if (body.starred !== true && body.starred !== false) {
      return Response.json({ error: 'starred must be a boolean' }, { status: 400 });
    }
    updates.starred = body.starred;
  }
  if (Object.hasOwn(body, 'folderId')) {
    if (body.folderId !== null) {
      if (!isUuid(body.folderId) || !(await fetchOwnedFolder(sql, userId, body.folderId)).length) {
        return Response.json({ error: 'folderId must be one of your folders' }, { status: 400 });
      }
    }
    updates.folder_id = body.folderId;
  }
  if (Object.hasOwn(body, 'blocks')) {
    const blocks = normalizeBlocks(body.blocks);
    if (!blocks)
      return Response.json({ error: 'blocks must be an array of block objects' }, { status: 400 });
    // sql.json, never a pre-stringified string: postgres.js would store that
    // as a jsonb string scalar rather than the array itself.
    updates.blocks = sql.json(blocks);
    newBlocks = blocks;
  }
  if (Object.hasOwn(body, 'tags')) {
    const tags = normalizeDocumentTags(body.tags);
    if (!tags)
      return Response.json(
        { error: 'tags must be an array of valid document tags' },
        { status: 400 },
      );
    updates.tags = sql.array(tags);
  }
  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 });
  }

  // content_text is derived from the document's *effective* post-save
  // title+blocks, so a save that only touches one of them still needs the
  // other's current value.
  const touchesTitle = Object.hasOwn(body, 'title');
  const touchesBlocks = Object.hasOwn(body, 'blocks');
  if (touchesTitle || touchesBlocks) {
    // newBlocks defaults to null (not undefined) when blocks aren't touched,
    // so effective-value resolution is driven by touchesTitle/touchesBlocks
    // rather than a value comparison that null would also satisfy.
    /** @type {any} */
    let effectiveTitle = touchesTitle ? updates.title : undefined;
    /** @type {any} */
    let effectiveBlocks = touchesBlocks ? newBlocks : undefined;
    if (!touchesTitle || !touchesBlocks) {
      const [current] =
        await sql`SELECT title, blocks FROM documents WHERE id = ${body.id} AND user_id = ${userId}`;
      if (!current) return Response.json({ error: 'Document not found' }, { status: 404 });
      if (!touchesTitle) effectiveTitle = current.title;
      if (!touchesBlocks) effectiveBlocks = current.blocks;
    }
    updates.content_text = computeSearchFields(effectiveTitle, effectiveBlocks).content_text;
  }

  const [document] = await sql.begin(
    async (/** @type {import('postgres').TransactionSql<any>} */ sql) => {
      // Only needed to diff against the post-update blocks below; skip the
      // extra round trip when this save doesn't touch blocks at all.
      const previous = newBlocks
        ? (
            await sql`SELECT folder_id, title, blocks FROM documents WHERE id = ${body.id} AND user_id = ${userId}`
          )[0]
        : null;

      // Compared at millisecond precision on both sides: updated_at is a
      // microsecond-precision timestamptz, but the only value a client can
      // echo back is what it received — a JS Date serialized to ISO, which
      // drops the microseconds. A raw `=` therefore rejected every save of a
      // row whose stored microseconds were not exactly zero, which is almost
      // all of them.
      const expectedUpdatedAt =
        typeof body.updatedAt === 'string' && body.updatedAt ? body.updatedAt : null;
      const rows = await sql`
        UPDATE documents d
        SET ${sql(updates)}, updated_at = now()
        WHERE d.id = ${body.id} AND d.user_id = ${userId}
          AND (${expectedUpdatedAt}::timestamptz IS NULL
            OR date_trunc('milliseconds', d.updated_at)
               = date_trunc('milliseconds', ${expectedUpdatedAt}::timestamptz))
        RETURNING d.id, d.folder_id, d.title, d.emoji, d.starred, d.tags, d.created_at, d.updated_at
      `;
      const updated = rows[0];
      if (updated && previous) {
        const eventDate = await resolveDailyNoteEventDate(
          sql,
          userId,
          updated.folder_id,
          updated.title,
        );
        if (eventDate) {
          await syncDailyNoteEvents(
            sql,
            userId,
            updated.id,
            eventDate,
            previous.blocks,
            /** @type {any[]} */ (newBlocks),
          );
        }
      }
      return rows;
    },
  );
  if (!document) {
    if (typeof body.updatedAt === 'string' && body.updatedAt) {
      const [existing] =
        await sql`SELECT 1 FROM documents d WHERE d.id = ${body.id} AND d.user_id = ${userId}`;
      if (existing) {
        return Response.json(
          { error: 'Document was updated elsewhere — reload and retry' },
          { status: 409 },
        );
      }
    }
    return Response.json({ error: 'Document not found' }, { status: 404 });
  }
  // Best-effort; already swallows its own errors, so this never risks the
  // response over a search-indexing problem. Called after the transaction
  // above has committed, never from inside it.
  await syncDocumentToMeili(sql, env, document.id);
  return Response.json({ document });
}

/**
 * DELETE /documents — deletes a folder/template (with body.kind set) or a
 * document (default). Folder deletion cascades to sub-folders in the
 * schema; their documents drop back to the root via ON DELETE SET NULL
 * rather than vanishing.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {any} env
 */
export async function deleteDocument(sql, userId, body, env = {}) {
  if (!isUuid(body.id)) return Response.json({ error: 'A valid id is required' }, { status: 400 });

  const result =
    body.kind === 'folder'
      ? await sql`
          DELETE FROM document_folders f
          WHERE f.id = ${body.id} AND f.user_id = ${userId}
          RETURNING f.id
        `
      : body.kind === 'template'
        ? await sql`
          DELETE FROM document_templates t
          WHERE t.id = ${body.id} AND t.user_id = ${userId}
          RETURNING t.id
        `
        : await sql`
          DELETE FROM documents d
          WHERE d.id = ${body.id} AND d.user_id = ${userId}
          RETURNING d.id
        `;
  if (!result.length) {
    const subject =
      body.kind === 'folder' ? 'Folder' : body.kind === 'template' ? 'Template' : 'Document';
    return Response.json({ error: `${subject} not found` }, { status: 404 });
  }
  // Only a document row (not a folder or template) lives in the Meilisearch
  // index. Best-effort; already swallows its own errors.
  if (body.kind !== 'folder' && body.kind !== 'template') {
    await removeDocumentFromMeili(env, body.id);
  }
  return Response.json({ ok: true });
}
