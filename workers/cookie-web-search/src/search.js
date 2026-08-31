// Ported from Cookie-Web's api/search.js. Behaviorally identical (same
// queries, same validation and quota order, same response shapes/status
// codes) — only the (req, res) mutation style becomes returning a Response,
// and configuration comes from the Worker env instead of process.env.
// Retrieval is served by Meilisearch unconditionally: the old three-leg
// Postgres path and its engine=postgres comparison handle are gone.

import { parseSearchQuery } from './queryParse.js';
import {
  MESSAGES_INDEX,
  hybridSearch as realHybridSearch,
  meiliMessageFilter,
} from '../../../shared/meili.js';

const MAX_QUERY_CHARS = 500;
const RESULTS = 20;

/**
 * @typedef {{
 *   hybridSearch: (env: any, descriptor: any, query: {userId: string, text?: string, filter?: string, limit: number, semanticRatio?: number, sort?: string[]}, client?: any) => Promise<{id: string}[]>,
 * }} SearchDeps
 */

/** @type {SearchDeps} */
const DEFAULT_DEPS = { hybridSearch: realHybridSearch };

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
           m.is_sent, m.scheduled_for, m.follow_up_at, ai.spam_score,
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
    GROUP BY m.id, ai.spam_score
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
 * @param {{text: string, prefixQuery: string | null, filters: Record<string, any>}} spec
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
