// Ported from Cookie-Web's api/_lib/documents.js. Behaviorally identical
// (same queries, same validation, same response shapes/status codes) —
// only the (req, res) mutation style becomes returning a Response, and
// OpenAI/rate-limit dependencies are passed in explicitly (`deps`) rather
// than pulled from a services object or process.env.
//
// Was reached via GET/POST/PATCH/DELETE /api/tasks?resource=documents in
// Cookie-Web's Vercel deployment, purely to stay under Vercel Hobby's
// 12-function cap. This Worker has no such limit, so it's its own clean
// /documents route — but keeps the *internal* dispatch (id/templateId/
// templates/q query params on GET, body.kind on POST/PATCH/DELETE)
// unchanged: that logic is proven correct, and this is already the largest,
// highest-risk port in the migration.

import { normalizeDocumentTags } from './documentTags.js';
import { resolveDailyNoteEventDate, syncDailyNoteEvents } from './dailyEventSync.js';
import { flattenBlocksToText } from './documentText.js';
import { keywordLeg, recencyLeg, vectorLeg } from './documentRetrieval.js';
import { parseDocumentSearchQuery } from './queryParse.js';
import { fuseRankings } from './rankFusion.js';
import { EMBEDDING_MODEL } from './embeddings.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_TITLE_LENGTH = 300;
export const MAX_EMOJI_LENGTH = 16;
// Blocks are stored verbatim, including base64 images, so the cap is generous
// but still bounds a single row (and request) to something sane.
export const MAX_BLOCKS_BYTES = 6 * 1024 * 1024;

const MAX_SEARCH_QUERY_CHARS = 500;
const SEARCH_CANDIDATES = 40; // per leg, before fusion
const SEARCH_RESULTS = 20;
// Shared with every other user-triggered AI route.
const SEARCH_RATE_LIMIT = { limit: 10, windowMs: 60_000 };
// A dedicated, more generous bucket for the save-time embedding call: it's an
// autosave side effect, not a user-initiated AI action, so a heavy editing
// session must not starve concurrent search/ask/compose requests from the
// same user by draining their shared 'ai' quota.
const EMBED_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
// flushPendingSave() serializes autosave PATCHes, so a hung OpenAI call would
// stall every edit queued behind it — bound how long a save-time embed call
// can take before giving up and saving without one.
const EMBED_TIMEOUT_MS = 5000;

/**
 * @typedef {{
 *   openaiApiKey: string | undefined,
 *   allowRequest: (sql: import('postgres').Sql, userId: string, scope: string, policy: {limit: number, windowMs: number}) => Promise<boolean>,
 *   embedText: (text: string, apiKey: string, options?: {signal?: AbortSignal}) => Promise<number[]>,
 *   embedTextCached: (text: string, apiKey: string) => Promise<number[]>,
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

// Fetches the fused search result ids in one list-shaped query, matching
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

// Best-effort content_text + embedding for a document's current title/blocks,
// computed from the same flattened text so the tsvector (content_text) and
// the semantic vector never disagree about what a document "says". Never
// throws: a missing API key, exhausted quota, a timeout, or an OpenAI failure
// just means embedding/embedding_model are omitted from this save — content
// search still works off content_text, and the weekly backfill catches any
// stragglers. Must never delay or fail the caller's PATCH/POST over an
// embedding problem.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{title: string, blocks: any[]}} doc
 * @param {DocumentsDeps} deps
 */
async function computeSearchFields(sql, userId, { title, blocks }, deps) {
  const contentText = flattenBlocksToText(title, blocks);
  const fields = /** @type {{content_text: string, embedding: number[] | null, embedding_model: string | null}} */ ({
    content_text: contentText,
    embedding: null,
    embedding_model: null,
  });
  if (!contentText.trim() || !deps.openaiApiKey) return fields;
  try {
    const allowed = await deps.allowRequest(sql, userId, 'doc-embed', EMBED_RATE_LIMIT);
    if (!allowed) return fields;
    fields.embedding = await deps.embedText(contentText, deps.openaiApiKey, {
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    fields.embedding_model = EMBEDDING_MODEL;
  } catch (err) {
    console.log(JSON.stringify({ event: 'document_embedding_failed', message: /** @type {Error} */ (err).message }));
  }
  return fields;
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
    if (!isUuid(id)) return Response.json({ error: 'A valid document id is required' }, { status: 400 });
    const [document] = await fetchDocument(sql, userId, id);
    if (!document) return Response.json({ error: 'Document not found' }, { status: 404 });
    return Response.json({ document });
  }

  const [folders, documents] = await fetchWorkspace(sql, userId);
  return Response.json({ folders, documents });
}

// GET /documents?q=…[&mode=keyword] — hybrid (keyword + semantic) search
// over the caller's documents, fused with reciprocal rank fusion.
// mode=keyword is the lower-latency type-ahead path and skips embeddings.
// Response shape matches the workspace list (no blocks).
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
  const semantic = url.searchParams.get('mode') !== 'keyword';

  // Split the raw query into free text, a prefix tsquery, and structured
  // operators (tag:/is:starred). A query containing only empty recognized
  // operators has no work to do and must not spend AI quota.
  const spec = parseDocumentSearchQuery(rawQuery);
  const hasFilters = Object.keys(spec.filters).length > 0;
  if (!spec.text && !hasFilters) {
    return Response.json({ documents: [] });
  }

  // Only hybrid search spends AI quota. Keyword-only type-ahead remains a
  // normal authenticated database query and cannot exhaust the shared AI
  // allowance merely because a user paused while typing.
  if (semantic && spec.text && deps.openaiApiKey) {
    let allowed;
    try {
      allowed = await deps.allowRequest(sql, userId, 'ai', SEARCH_RATE_LIMIT);
    } catch (err) {
      console.log(JSON.stringify({ event: 'document_search_quota_failed', message: /** @type {Error} */ (err).message }));
      return Response.json({ error: 'Search is temporarily unavailable' }, { status: 503 });
    }
    if (!allowed) {
      return Response.json({ error: 'Too many searches, slow down' }, { status: 429 });
    }
  }

  // Semantic leg is best-effort: no key, no free text, or an OpenAI failure
  // degrades to keyword/recency search rather than failing the request.
  const semanticIds = async () => {
    if (!semantic || !spec.text || !deps.openaiApiKey) return [];
    try {
      const vector = JSON.stringify(await deps.embedTextCached(spec.text, deps.openaiApiKey));
      return await vectorLeg(sql, userId, vector, spec.filters, SEARCH_CANDIDATES);
    } catch (err) {
      console.log(JSON.stringify({ event: 'document_search_vector_leg_failed', message: /** @type {Error} */ (err).message }));
      return [];
    }
  };

  // Free-text queries rank purely by relevance (keyword + semantic);
  // recency is only the keyword leg's tie-breaker. A filters-only query has
  // no relevance signal, so it falls back to the recency leg newest-first.
  const keywordIds = spec.text ? keywordLeg(sql, userId, spec, SEARCH_CANDIDATES) : Promise.resolve([]);
  const recencyIds = spec.text ? Promise.resolve([]) : recencyLeg(sql, userId, spec, SEARCH_CANDIDATES);

  const [keywordRows, recencyRows, vectorRows] = await Promise.all([keywordIds, recencyIds, semanticIds()]);

  const ids = fuseRankings([
    keywordRows.map((/** @type {any} */ r) => r.id),
    recencyRows.map((/** @type {any} */ r) => r.id),
    vectorRows.map((/** @type {any} */ r) => r.id),
  ]).slice(0, SEARCH_RESULTS);

  if (ids.length === 0) return Response.json({ documents: [] });

  const rows = await fetchSearchDocuments(sql, userId, ids);
  const byId = new Map(rows.map((/** @type {any} */ row) => [row.id, row]));
  const documents = ids.map((id) => byId.get(id)).filter(Boolean);

  return Response.json({ documents });
}

/**
 * POST /documents — creates a folder, document, or template depending on
 * body.kind.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {DocumentsDeps} deps
 */
export async function createDocument(sql, userId, body, deps) {
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
      return Response.json({ error: 'A template title and valid blocks are required' }, { status: 400 });
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
        return Response.json({ error: 'templateId must be one of your templates' }, { status: 400 });
      }
      [template] = await fetchTemplate(sql, userId, body.templateId);
      if (!template) {
        return Response.json({ error: 'templateId must be one of your templates' }, { status: 400 });
      }
    }
    const title = cleanText(body.title, MAX_TITLE_LENGTH) ?? template?.title ?? '';
    const emoji = template?.emoji ?? '🔹';
    const blocks = template?.blocks ?? [];
    // Awaited before the INSERT so a slow/failed OpenAI call never holds a DB
    // round trip open — see computeSearchFields. Branches into two full
    // statements (rather than a conditionally-nested embedding fragment)
    // since the vector column needs an explicit ::extensions.vector cast
    // that only applies when there is a vector to write.
    const searchFields = await computeSearchFields(sql, userId, { title, blocks }, deps);
    const [document] = searchFields.embedding
      ? await sql`
          INSERT INTO documents (user_id, folder_id, title, emoji, blocks, content_text, embedding, embedding_model)
          VALUES (
            ${userId}, ${folderId}, ${title}, ${emoji}, ${sql.json(blocks)}, ${searchFields.content_text},
            ${JSON.stringify(searchFields.embedding)}::extensions.vector, ${searchFields.embedding_model}
          )
          RETURNING id, folder_id, title, emoji, starred, tags, blocks, created_at, updated_at
        `
      : await sql`
          INSERT INTO documents (user_id, folder_id, title, emoji, blocks, content_text)
          VALUES (${userId}, ${folderId}, ${title}, ${emoji}, ${sql.json(blocks)}, ${searchFields.content_text})
          RETURNING id, folder_id, title, emoji, starred, tags, blocks, created_at, updated_at
        `;
    return Response.json({ document }, { status: 201 });
  }

  return Response.json({ error: "kind must be 'folder', 'document', or 'template'" }, { status: 400 });
}

/**
 * PATCH /documents — updates a folder/template (with body.kind set) or a
 * document (default).
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {DocumentsDeps} deps
 */
export async function updateDocument(sql, userId, body, deps) {
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
      return Response.json({ error: 'A template title and valid blocks are required' }, { status: 400 });
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
    if (!emoji) return Response.json({ error: 'emoji must be a non-empty string' }, { status: 400 });
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
    if (!blocks) return Response.json({ error: 'blocks must be an array of block objects' }, { status: 400 });
    // sql.json, never a pre-stringified string: postgres.js would store that
    // as a jsonb string scalar rather than the array itself.
    updates.blocks = sql.json(blocks);
    newBlocks = blocks;
  }
  if (Object.hasOwn(body, 'tags')) {
    const tags = normalizeDocumentTags(body.tags);
    if (!tags) return Response.json({ error: 'tags must be an array of valid document tags' }, { status: 400 });
    updates.tags = sql.array(tags);
  }
  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 });
  }

  // content_text/embedding are derived from the document's *effective*
  // post-save title+blocks, so a save that only touches one of them still
  // needs the other's current value — fetched here (outside the transaction
  // below, which exists only for the unrelated daily-note-event diff) so a
  // slow/failed OpenAI call in computeSearchFields never holds a DB
  // transaction open.
  /** @type {number[] | null} */
  let embeddingVector = null;
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
      const [current] = await sql`SELECT title, blocks FROM documents WHERE id = ${body.id} AND user_id = ${userId}`;
      if (!current) return Response.json({ error: 'Document not found' }, { status: 404 });
      if (!touchesTitle) effectiveTitle = current.title;
      if (!touchesBlocks) effectiveBlocks = current.blocks;
    }
    const searchFields = await computeSearchFields(sql, userId, { title: effectiveTitle, blocks: effectiveBlocks }, deps);
    updates.content_text = searchFields.content_text;
    if (searchFields.embedding) {
      updates.embedding_model = searchFields.embedding_model;
      embeddingVector = searchFields.embedding;
    }
  }

  const [document] = await sql.begin(async (/** @type {import('postgres').TransactionSql<any>} */ sql) => {
    // Only needed to diff against the post-update blocks below; skip the
    // extra round trip when this save doesn't touch blocks at all.
    const previous = newBlocks
      ? (await sql`SELECT folder_id, title, blocks FROM documents WHERE id = ${body.id} AND user_id = ${userId}`)[0]
      : null;

    // Branches into two full statements (rather than a conditionally-nested
    // embedding fragment) since the vector column needs an explicit
    // ::extensions.vector cast that only applies when there is a new vector
    // to write — a rate-limited or skipped embed must leave the existing
    // column untouched, not null it out.
    const rows = embeddingVector
      ? await sql`
          UPDATE documents d
          SET ${sql(updates)}, updated_at = now(), embedding = ${JSON.stringify(embeddingVector)}::extensions.vector
          WHERE d.id = ${body.id} AND d.user_id = ${userId}
          RETURNING d.id, d.folder_id, d.title, d.emoji, d.starred, d.tags, d.created_at, d.updated_at
        `
      : await sql`
          UPDATE documents d
          SET ${sql(updates)}, updated_at = now()
          WHERE d.id = ${body.id} AND d.user_id = ${userId}
          RETURNING d.id, d.folder_id, d.title, d.emoji, d.starred, d.tags, d.created_at, d.updated_at
        `;
    const updated = rows[0];
    if (updated && previous) {
      const eventDate = await resolveDailyNoteEventDate(sql, userId, updated.folder_id, updated.title);
      if (eventDate) {
        await syncDailyNoteEvents(sql, userId, updated.id, eventDate, previous.blocks, /** @type {any[]} */ (newBlocks));
      }
    }
    return rows;
  });
  if (!document) return Response.json({ error: 'Document not found' }, { status: 404 });
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
 */
export async function deleteDocument(sql, userId, body) {
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
    const subject = body.kind === 'folder' ? 'Folder' : body.kind === 'template' ? 'Template' : 'Document';
    return Response.json({ error: `${subject} not found` }, { status: 404 });
  }
  return Response.json({ ok: true });
}
