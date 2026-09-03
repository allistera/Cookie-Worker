// Ported from Cookie-Web's api/search.js. Behaviorally identical (same
// queries, same validation and quota order, same response shapes/status
// codes) — only the (req, res) mutation style becomes returning a Response,
// and configuration comes from the Worker env instead of process.env.
// Retrieval is served by Meilisearch unconditionally: the old three-leg
// Postgres path and its engine=postgres comparison handle are gone.

import { hasMailOnlyFilters, parseFederatedSearchQuery, parseSearchQuery } from './queryParse.js';
import {
  MESSAGES_INDEX,
  hybridSearch as realHybridSearch,
  federatedSearch as realFederatedSearch,
  meiliMessageFilter,
} from '../../../shared/meili.js';
import { DOCUMENTS_INDEX } from '../../../shared/meili/documents.js';
import { TASKS_INDEX } from '../../../shared/meili/tasks.js';

const MAX_QUERY_CHARS = 500;
const RESULTS = 20;

// GET /search?scope=… defaults and cap. Fixed by the response contract the
// frontend is built against — see handleScopedSearch.
const DEFAULT_SCOPED_LIMIT = 20;
const MAX_SCOPED_LIMIT = 50;
const SCOPES = new Set(['all', 'mail', 'documents', 'tasks']);

/**
 * @typedef {{
 *   hybridSearch: (env: any, descriptor: any, query: {userId: string, text?: string, filter?: string, limit: number, semanticRatio?: number, sort?: string[]}, client?: any) => Promise<{id: string}[]>,
 *   federatedSearch: (env: any, units: import('../../../shared/meili.js').FederatedSearchUnit[], options: {userId: string, limit: number, offset?: number}, client?: any) => Promise<{hits: {id: string, _federation: any}[], estimatedTotalHits: number}>,
 * }} SearchDeps
 */

/** @type {SearchDeps} */
const DEFAULT_DEPS = { hybridSearch: realHybridSearch, federatedSearch: realFederatedSearch };

// Fetches the fused result ids in one list-shaped query. Only summary presence
// is exposed here; the generated text remains on the owned-message endpoint.
// Bodies are excluded for the same reason as the emails Worker's fetchEmails:
// results render the stored snippet and fetch the authoritative body only
// when opened.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string[]} ids
 */
export function fetchSearchEmails(sql, userId, ids) {
  return sql`
    SELECT m.id, m.from_name, m.from_address,
           CASE WHEN jsonb_typeof(m.recipients) = 'string'
                THEN (m.recipients #>> '{}')::jsonb
                ELSE m.recipients END AS recipients,
           m.subject, m.snippet,
           m.sent_at, m.is_unread, m.is_starred,
           m.is_sent, m.is_archived, m.scheduled_for, m.follow_up_at, ai.spam_score, ai.spam_verdict,
           BOOL_OR(NULLIF(BTRIM(ai.summary), '') IS NOT NULL) AS has_ai_summary,
           (m.body_html IS NOT NULL) AS has_html,
           EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
           COALESCE(
             json_agg(json_build_object('name', l.name, 'color', l.color, 'kind', l.kind)
                      ORDER BY l.name)
               FILTER (WHERE l.id IS NOT NULL),
             '[]'
           ) AS labels
    FROM messages m
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    LEFT JOIN message_labels ml ON ml.message_id = m.id
    LEFT JOIN labels l ON l.id = ml.label_id
    WHERE m.user_id = ${userId}
      AND NOT m.is_deleted
      AND m.id = ANY(${ids}::uuid[])
    GROUP BY m.id, ai.spam_score, ai.spam_verdict
  `;
}

// Ported from cookie-web-tasks/src/documents.js's fetchSearchDocuments, narrowed
// to the fields the federated response contract exposes for a document hit
// (type "document" — see mergeFederatedResults). user_id is a second gate on
// top of the escaped filter federatedSearch already applied in Meilisearch —
// same belt-and-suspenders pattern fetchSearchEmails uses above.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string[]} ids
 */
export function fetchSearchDocuments(sql, userId, ids) {
  return sql`
    SELECT d.id, d.title, d.tags, d.starred, d.updated_at
    FROM documents d
    WHERE d.user_id = ${userId} AND d.id = ANY(${ids}::uuid[])
  `;
}

// Task hits hydrate the fields the Tasks view needs to render and open a
// result: projectId routes to /tasks?project=…&task=…, and completedAt is
// belt-and-suspenders — the tasks leg filters `completed = false` in
// Meilisearch, but a stale index could still surface one.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string[]} ids
 */
export function fetchSearchTasks(sql, userId, ids) {
  return sql`
    SELECT t.id, t.content, t.description, t.project_id AS "projectId",
           to_char(t.due_date, 'YYYY-MM-DD') AS "dueDate", t.completed_at AS "completedAt"
    FROM task_items t
    WHERE t.user_id = ${userId} AND t.id = ANY(${ids}::uuid[])
  `;
}

// Hydrates a Meilisearch id list into full email rows (in id order) and
// wraps them in the search response shape.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string[]} ids
 */
async function respondWithEmails(sql, userId, ids) {
  if (ids.length === 0) return Response.json({ emails: [] });

  const rows = await fetchSearchEmails(sql, userId, ids);
  const byId = new Map(rows.map((/** @type {any} */ row) => [row.id, row]));
  const emails = ids.map((id) => byId.get(id)).filter(Boolean);

  return Response.json({ emails });
}

// Message search. hits carry only ids (attributesToRetrieve inside
// hybridSearch), so the rows still come from Postgres via respondWithEmails.
// Meilisearch is required: a failure here is an error (503), never a silent
// fallback.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{text: string, filters: Record<string, any>}} spec
 * @param {any} env
 * @param {boolean} semantic false when mode=keyword — forces keyword-only
 *   (semanticRatio 0) so type-ahead never spends an embedding call.
 * @param {SearchDeps} deps
 */
async function searchViaMeili(sql, userId, spec, env, semantic, deps) {
  let hits;
  try {
    hits = await deps.hybridSearch(env, MESSAGES_INDEX, {
      userId,
      text: spec.text ?? '',
      filter: meiliMessageFilter(spec.filters),
      limit: RESULTS,
      // mode=keyword maps to semanticRatio 0 — Meilisearch's keyword-only
      // setting, matching the old Postgres keyword leg. Omitting the key
      // entirely (rather than sending semanticRatio: undefined) lets
      // hybridSearch fall back to the index descriptor's default ratio.
      ...(semantic ? {} : { semanticRatio: 0 }),
      // No free text means no relevance signal, so fall back to newest-first
      // — what the recency leg did.
      ...(spec.text ? {} : { sort: ['sent_at:desc'] }),
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'message_search_meili_failed',
        message: /** @type {Error} */ (error).message,
      }),
    );
    return Response.json({ error: 'Search is unavailable' }, { status: 503 });
  }

  const ids = hits.map((hit) => hit.id);
  return await respondWithEmails(sql, userId, ids);
}

/**
 * GET /search?q=… — hybrid (keyword + semantic) search over the authenticated
 * user's messages, served by Meilisearch. A Meilisearch failure returns 503
 * rather than degrading to anything else. Response shape matches the emails
 * Worker's GET /emails.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 * @param {{OPENAI_API_KEY?: string}} env
 * @param {SearchDeps} [deps]
 */
export async function handleSearch(sql, userId, url, env, deps = DEFAULT_DEPS) {
  // scope=all|mail|documents is the federated (mail + documents) path added
  // for Cookie's cross-content search; its own fixed response shape (see
  // handleScopedSearch) is unrelated to the shape below, which Cookie-iOS
  // depends on byte-for-byte. Absent scope keeps that behavior untouched.
  const scope = url.searchParams.get('scope');
  if (scope) return handleScopedSearch(sql, userId, url, env, scope, deps);

  const q = (url.searchParams.get('q') || '').trim();
  const semantic = url.searchParams.get('mode') !== 'keyword';
  if (!q || q.length > MAX_QUERY_CHARS) {
    return Response.json({ error: 'q is required (max 500 chars)' }, { status: 400 });
  }

  // Split the raw query into free text, a prefix tsquery, and structured
  // operators (sender:/tag:/from:/to:/has:/before:/after:/in:). A query
  // containing only empty recognized operators has no work to do and must
  // not spend AI quota.
  const spec = parseSearchQuery(q);
  const hasFilters = Object.keys(spec.filters).length > 0;
  if (!spec.text && !hasFilters) {
    return Response.json({ emails: [] });
  }

  return await searchViaMeili(sql, userId, spec, env, semantic, deps);
}

// meiliMessageFilter has no notion of is:starred (mail search never needed
// it before this endpoint), so it's layered on here rather than changing
// that shared, independently-tested filter builder for one caller.
/** @param {{starred?: true, [key: string]: any}} filters */
function messagesFilterFor(filters) {
  const base = meiliMessageFilter(filters);
  return filters.starred ? [base, 'is_starred = true'].filter(Boolean).join(' AND ') : base;
}

// Mirrors cookie-web-tasks/src/documents.js's own (unexported) meiliFilter —
// documents only ever filter on tags/starred, and duplicating this handful
// of lines keeps this Worker independent of another Worker's source tree.
/** @param {string} value */
function escapeMeiliFilterValue(value) {
  return value.replace(/[\\']/g, '\\$&');
}

/** @param {{tag?: string, starred?: true, [key: string]: any}} filters */
function documentsFilterFor(filters) {
  const parts = [];
  if (filters.tag) parts.push(`tags = '${escapeMeiliFilterValue(String(filters.tag))}'`);
  if (filters.starred) parts.push('starred = true');
  return parts.join(' AND ') || undefined;
}

/** @param {URL} url */
function parseScopedLimit(url) {
  const raw = Number(url.searchParams.get('limit'));
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SCOPED_LIMIT;
  return Math.min(Math.floor(raw), MAX_SCOPED_LIMIT);
}

/** @param {URL} url */
function parseScopedOffset(url) {
  const raw = Number(url.searchParams.get('offset'));
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

// Re-merges federated hits — ordered by Meilisearch's federation ranking —
// with the Postgres rows hydrated for each index, preserving that order. A
// hit whose row never hydrated (e.g. deleted between the Meilisearch query
// and the Postgres read) is dropped, matching the .filter(Boolean) every
// other id-hydration path in this file already does.
/**
 * @param {{id: string, _federation?: {indexUid?: string}}[]} hits
 * @param {any[]} emailRows
 * @param {any[]} documentRows
 * @param {any[]} [taskRows]
 */
export function mergeFederatedResults(hits, emailRows, documentRows, taskRows = []) {
  const emailsById = new Map(emailRows.map((row) => [row.id, row]));
  const documentsById = new Map(documentRows.map((row) => [row.id, row]));
  const tasksById = new Map(taskRows.map((row) => [row.id, row]));

  return hits
    .map((hit) => {
      const indexUid = hit._federation?.indexUid;
      if (indexUid === MESSAGES_INDEX.name) {
        const row = emailsById.get(hit.id);
        return row ? { type: 'email', ...row } : null;
      }
      if (indexUid === DOCUMENTS_INDEX.name) {
        const row = documentsById.get(hit.id);
        return row
          ? {
              type: 'document',
              id: row.id,
              title: row.title,
              tags: row.tags,
              starred: row.starred,
              updated_at: row.updated_at,
            }
          : null;
      }
      if (indexUid === TASKS_INDEX.name) {
        const row = tasksById.get(hit.id);
        return row
          ? {
              type: 'task',
              id: row.id,
              content: row.content,
              description: row.description,
              projectId: row.projectId,
              dueDate: row.dueDate,
              completedAt: row.completedAt,
            }
          : null;
      }
      return null;
    })
    .filter(Boolean);
}

// GET /search?q=…&scope=all|mail|documents|tasks — federated mail + documents
// + tasks search via Meilisearch's multi-search federation (shared/meili.js's
// federatedSearch). Single-index scopes run the same federated path with a
// single query unit rather than a separate one, so there is one merge/hydrate
// code path regardless of scope. tag:/is:starred apply to mail and documents;
// the mail-only operators (in:/from:/to:/has:/before:/after:) drop the
// documents leg entirely under scope=all rather than running it with the
// operator silently ignored (see hasMailOnlyFilters). Tasks understand no
// operator at all, so any filter drops the tasks leg the same way.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 * @param {any} env
 * @param {string} scope
 * @param {SearchDeps} deps
 */
async function handleScopedSearch(sql, userId, url, env, scope, deps) {
  if (!SCOPES.has(scope)) {
    return Response.json(
      { error: 'scope must be one of: all, mail, documents, tasks' },
      { status: 400 },
    );
  }

  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length > MAX_QUERY_CHARS) {
    return Response.json({ error: 'q is required (max 500 chars)' }, { status: 400 });
  }

  const limit = parseScopedLimit(url);
  const offset = parseScopedOffset(url);

  const spec = parseFederatedSearchQuery(q);
  const hasFilters = Object.keys(spec.filters).length > 0;
  if (!spec.text && !hasFilters) {
    return Response.json({ query: q, results: [], estimatedTotalHits: 0, limit, offset });
  }

  // Documents have no sender/recipients/attachments/sent date/folder — a
  // mail-only operator under scope=documents has nothing to filter on, so
  // this must not run and return every document as if the operator weren't
  // there (the same failure mode scope=all's leg-dropping avoids).
  if (scope === 'documents' && hasMailOnlyFilters(spec.filters)) {
    return Response.json({ query: q, results: [], estimatedTotalHits: 0, limit, offset });
  }

  // Tasks understand no structured operator at all — not even tag:/is:starred
  // (a task has no tags or star). Same rule as above: any operator under
  // scope=tasks must not run and return every task as if it weren't there.
  if (scope === 'tasks' && hasFilters) {
    return Response.json({ query: q, results: [], estimatedTotalHits: 0, limit, offset });
  }

  // Filter-only queries (no free text) have no relevance signal, so — like
  // the unscoped mail path — they must not spend an embedding call.
  const semantic = url.searchParams.get('mode') !== 'keyword' && Boolean(spec.text);

  const units = [];
  if (scope === 'mail' || scope === 'all') {
    units.push({
      descriptor: MESSAGES_INDEX,
      q: spec.text,
      filter: messagesFilterFor(spec.filters),
      ...(semantic ? {} : { semantic: false }),
    });
  }
  const wantsDocuments =
    scope === 'documents' || (scope === 'all' && !hasMailOnlyFilters(spec.filters));
  if (wantsDocuments) {
    units.push({
      descriptor: DOCUMENTS_INDEX,
      q: spec.text,
      filter: documentsFilterFor(spec.filters),
      ...(semantic ? {} : { semantic: false }),
    });
  }
  // No operator applies to tasks, so any filter drops this leg under
  // scope=all (scope=tasks already short-circuited above). Completed tasks
  // stay indexed but out of results — see TASKS_INDEX.
  const wantsTasks = scope === 'tasks' || (scope === 'all' && !hasFilters);
  if (wantsTasks) {
    units.push({
      descriptor: TASKS_INDEX,
      q: spec.text,
      filter: 'completed = false',
      ...(semantic ? {} : { semantic: false }),
    });
  }

  // No free text means no relevance signal to sort by; fall back to
  // newest-first, mirroring the unscoped mail path's sort:['sent_at:desc']
  // (searchViaMeili). Only safe with exactly one leg running — sent_at
  // (messages, epoch seconds) and updated_at (documents, epoch
  // milliseconds) are not cross-comparable, so scope=all with both legs
  // still running gets no sort at all.
  if (!spec.text && units.length === 1) {
    const [unit] = units;
    unit.sort = unit.descriptor === MESSAGES_INDEX ? ['sent_at:desc'] : ['updated_at:desc'];
  }

  let federated;
  try {
    federated = await deps.federatedSearch(env, units, { userId, limit, offset });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'federated_search_meili_failed',
        message: /** @type {Error} */ (error).message,
      }),
    );
    return Response.json({ error: 'Search is unavailable' }, { status: 503 });
  }

  const mailIds = federated.hits
    .filter((hit) => hit._federation?.indexUid === MESSAGES_INDEX.name)
    .map((hit) => hit.id);
  const documentIds = federated.hits
    .filter((hit) => hit._federation?.indexUid === DOCUMENTS_INDEX.name)
    .map((hit) => hit.id);
  const taskIds = federated.hits
    .filter((hit) => hit._federation?.indexUid === TASKS_INDEX.name)
    .map((hit) => hit.id);

  const [emailRows, documentRows, taskRows] = await Promise.all([
    mailIds.length ? fetchSearchEmails(sql, userId, mailIds) : Promise.resolve([]),
    documentIds.length ? fetchSearchDocuments(sql, userId, documentIds) : Promise.resolve([]),
    taskIds.length ? fetchSearchTasks(sql, userId, taskIds) : Promise.resolve([]),
  ]);

  const results = mergeFederatedResults(federated.hits, emailRows, documentRows, taskRows);

  return Response.json({
    query: q,
    results,
    estimatedTotalHits: federated.estimatedTotalHits,
    limit,
    offset,
  });
}
