// Ported verbatim from Cookie-Web's api/_lib/documentRetrieval.js — pure SQL
// query builders, no Node APIs.
//
// Shared hybrid-retrieval legs for the documents search handler: keyword,
// recency, and vector legs fused by rankFusion.js. The legs take a parsed
// spec { text, prefixQuery, filters } (see queryParse.js's
// parseDocumentSearchQuery). `text` is the free-text query, `prefixQuery` is
// an optional prefix tsquery for search-as-you-type, and `filters` holds the
// structured tag:/is:starred operators applied as extra SQL predicates
// across every leg.

import { normalizeDocumentTag } from './documentTags.js';

/**
 * Full-text predicate: the free-text query OR, when present, the prefix
 * query, so an in-progress last word still matches. Both are
 * injection-safe: websearch_to_tsquery sanitises free text, and prefixQuery
 * is built from alphanumeric-only words in queryParse.js.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} text
 * @param {string | null} prefixQuery
 */
function textMatch(sql, text, prefixQuery) {
  if (prefixQuery) {
    return sql`(d.search @@ websearch_to_tsquery('english', ${text})
                OR d.search @@ to_tsquery('english', ${prefixQuery}))`;
  }
  return sql`d.search @@ websearch_to_tsquery('english', ${text})`;
}

/**
 * Relevance score: best of the free-text and prefix ranks. setweight() in
 * the generated column already boosts title over body via ts_rank's default
 * weights.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} text
 * @param {string | null} prefixQuery
 */
function rankExpr(sql, text, prefixQuery) {
  if (prefixQuery) {
    return sql`GREATEST(
      ts_rank(d.search, websearch_to_tsquery('english', ${text})),
      ts_rank(d.search, to_tsquery('english', ${prefixQuery}))
    )`;
  }
  return sql`ts_rank(d.search, websearch_to_tsquery('english', ${text}))`;
}

/**
 * Structured-operator predicates, ANDed into a leg's WHERE. Returns an empty
 * fragment when no filters are set. Invalid tag values (normalizeDocumentTag
 * returns null) fall back to the raw value so a not-a-real-tag search simply
 * matches nothing rather than throwing.
 *
 * @param {import('postgres').Sql} sql
 * @param {{tag?: string, starred?: boolean}} [filters]
 */
function filterClause(sql, filters = {}) {
  const parts = [];
  if (filters.tag) {
    const tag = normalizeDocumentTag(filters.tag) ?? filters.tag;
    parts.push(sql`AND d.tags @> ARRAY[${tag}]::text[]`);
  }
  if (filters.starred) {
    parts.push(sql`AND d.starred = true`);
  }
  return parts.reduce((acc, part) => sql`${acc} ${part}`, sql``);
}

/**
 * Keyword leg: full-text match ranked by relevance. Requires spec.text.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{text: string, prefixQuery: string | null, filters: any}} spec
 * @param {number} limit
 */
export function keywordLeg(sql, userId, spec, limit) {
  const { text, prefixQuery, filters } = spec;
  return sql`
    SELECT d.id
    FROM documents d
    WHERE d.user_id = ${userId}
      ${filterClause(sql, filters)}
      AND ${textMatch(sql, text, prefixQuery)}
    ORDER BY ${rankExpr(sql, text, prefixQuery)} DESC, d.updated_at DESC
    LIMIT ${limit}
  `;
}

/**
 * Recency leg: filter matches ordered newest-first. Used only for
 * filters-only queries (e.g. `tag:Work is:starred`) that carry no relevance
 * signal; for free-text search, recency is just the keyword leg's
 * tie-breaker so it never competes with relevance.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{text: string, prefixQuery: string | null, filters: any}} spec
 * @param {number} limit
 */
export function recencyLeg(sql, userId, spec, limit) {
  const { text, prefixQuery, filters } = spec;
  const match = text ? sql`AND ${textMatch(sql, text, prefixQuery)}` : sql``;
  return sql`
    SELECT d.id
    FROM documents d
    WHERE d.user_id = ${userId}
      ${filterClause(sql, filters)}
      ${match}
    ORDER BY d.updated_at DESC
    LIMIT ${limit}
  `;
}

/**
 * Vector leg: cosine distance over pgvector embeddings. Takes the query
 * vector (already embedded) so callers can cache or skip embedding, plus the
 * same structured filters so semantic results honour tag:/is:starred too.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} vector
 * @param {{tag?: string, starred?: boolean}} filters
 * @param {number} limit
 */
export function vectorLeg(sql, userId, vector, filters, limit) {
  return sql`
    SELECT d.id
    FROM documents d
    WHERE d.user_id = ${userId}
      ${filterClause(sql, filters)}
      AND d.embedding IS NOT NULL
    ORDER BY d.embedding <=> ${vector}::extensions.vector
    LIMIT ${limit}
  `;
}
