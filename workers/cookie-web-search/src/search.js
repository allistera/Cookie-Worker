// Ported from Cookie-Web's api/search.js. Behaviorally identical (same
// queries, same validation and quota order, same response shapes/status
// codes) — only the (req, res) mutation style becomes returning a Response,
// and configuration comes from the Worker env instead of process.env.

import { allowRequest } from '../../../shared/rate-limit.js';
import { embedTextCached } from '../../../shared/embeddings.js';
import { fuseRankings } from './rankFusion.js';
import { keywordLeg, recencyLeg, vectorLeg } from './retrieval.js';
import { parseSearchQuery } from './queryParse.js';
import {
  MESSAGES_INDEX,
  hybridSearch as realHybridSearch,
  meiliMessageFilter,
} from '../../../shared/meili.js';

const MAX_QUERY_CHARS = 500;
const CANDIDATES = 40; // per leg, before fusion
const RESULTS = 20;
const RATE_LIMIT = { limit: 10, windowMs: 60_000 }; // shared with all user-triggered AI routes

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

// Hydrates a fused/Meilisearch id list into full email rows (in id order) and
// wraps them in the search response shape. Shared by both engines so a
// Postgres-vs-Meilisearch comparison is only ever a difference in which ids
// come back, never in the response shape.
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

// The Meilisearch leg of message search. hits carry only ids
// (attributesToRetrieve inside hybridSearch), so the rows still come from
// Postgres via respondWithEmails — the same hydration the Postgres legs use,
// so both engines return byte-identical response shapes. Meilisearch is
// required: a failure here is an error (503), never a silent fallback to the
// Postgres legs below.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{text: string, prefixQuery: string | null, filters: Record<string, any>}} spec
 * @param {any} env
 * @param {SearchDeps} deps
 */
async function searchViaMeili(sql, userId, spec, env, deps) {
  let hits;
  try {
    hits = await deps.hybridSearch(env, MESSAGES_INDEX, {
      userId,
      text: spec.text ?? '',
      filter: meiliMessageFilter(spec.filters),
      limit: RESULTS,
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
 * user's messages, served by Meilisearch by default; &engine=postgres selects
 * the old three-leg Postgres path unchanged, as a soak-period comparison
 * handle — never selected automatically, and never a fallback: a Meilisearch
 * failure returns 503 rather than degrading to Postgres. Response shape
 * matches the emails Worker's GET /emails on both engines.
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

  // engine=postgres is the soak-period comparison handle, not a fallback: it
  // is never selected automatically, and phase 2 deletes it along with the
  // legs it reaches.
  const engine = url.searchParams.get('engine') === 'postgres' ? 'postgres' : 'meili';
  if (engine === 'meili') {
    return await searchViaMeili(sql, userId, spec, env, deps);
  }

  // Only hybrid search spends AI quota. Keyword-only type-ahead remains a
  // normal authenticated database query and cannot exhaust the shared AI
  // allowance merely because a user paused while typing.
  if (semantic && spec.text && env.OPENAI_API_KEY) {
    let allowed;
    try {
      allowed = await allowRequest(sql, userId, 'ai', RATE_LIMIT);
    } catch (err) {
      console.error('GET /search quota enforcement failed:', /** @type {Error} */ (err).message);
      return Response.json({ error: 'Search is temporarily unavailable' }, { status: 503 });
    }
    if (!allowed) {
      return Response.json({ error: 'Too many searches, slow down' }, { status: 429 });
    }
  }

  try {
    // Semantic leg is best-effort: no key, no free text, or an OpenAI failure
    // degrades to keyword/recency search rather than failing the request.
    const semanticIds = async () => {
      if (!semantic || !spec.text || !env.OPENAI_API_KEY) return [];
      try {
        const vector = JSON.stringify(await embedTextCached(spec.text, env.OPENAI_API_KEY));
        return await vectorLeg(sql, userId, vector, spec.filters, CANDIDATES);
      } catch (err) {
        console.error('GET /search vector leg failed:', /** @type {Error} */ (err).message);
        return [];
      }
    };

    // Free-text queries rank purely by relevance (keyword + semantic); recency
    // is only the keyword leg's tie-breaker, so results are not date-sorted. A
    // filters-only query has no relevance signal, so it falls back to the
    // recency leg ordered newest-first.
    const keywordIds = spec.text ? keywordLeg(sql, userId, spec, CANDIDATES) : Promise.resolve([]);
    const recencyIds = spec.text ? Promise.resolve([]) : recencyLeg(sql, userId, spec, CANDIDATES);

    const [keywordRows, recencyRows, vectorRows] = await Promise.all([
      keywordIds,
      recencyIds,
      semanticIds(),
    ]);

    const ids = fuseRankings([
      keywordRows.map((/** @type {{id: string}} */ r) => r.id),
      recencyRows.map((/** @type {{id: string}} */ r) => r.id),
      vectorRows.map((/** @type {{id: string}} */ r) => r.id),
    ]).slice(0, RESULTS);

    return await respondWithEmails(sql, userId, ids);
  } catch (err) {
    console.error('GET /search failed:', err);
    return Response.json({ error: 'Search failed' }, { status: 500 });
  }
}
