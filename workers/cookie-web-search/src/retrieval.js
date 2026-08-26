// Ported from Cookie-Web's api/_lib/retrieval.js, unchanged.
// Shared hybrid-retrieval legs for /api/search and /api/ask. All return ranked
// lists of message ids scoped to the authenticated user's mail, always
// excluding trashed messages and — unless filters.in says otherwise (see
// folderClause below) — excluding Done/archived mail too (sent copies are
// included by default; finding your own replies is a feature).
//
// The legs take a parsed spec { text, prefixQuery, filters } (see
// query-parse.js). `text` is the free-text query, `prefixQuery` is an optional
// prefix tsquery for search-as-you-type, and `filters` holds the structured
// operators applied as extra SQL predicates across every leg.

// Full-text predicate: the free-text query OR, when present, the prefix query,
// so an in-progress last word still matches. Both are injection-safe:
// websearch_to_tsquery sanitises free text, and prefixQuery is built from
// alphanumeric-only words in query-parse.js.
function textMatch(sql, text, prefixQuery) {
  if (prefixQuery) {
    return sql`(m.search @@ websearch_to_tsquery('english', ${text})
                OR m.search @@ to_tsquery('english', ${prefixQuery}))`;
  }
  return sql`m.search @@ websearch_to_tsquery('english', ${text})`;
}

// Relevance score: best of the free-text and prefix ranks. setweight() in the
// generated column already boosts subject/sender over body via ts_rank's
// default weights.
function rankExpr(sql, text, prefixQuery) {
  if (prefixQuery) {
    return sql`GREATEST(
      ts_rank(m.search, websearch_to_tsquery('english', ${text})),
      ts_rank(m.search, to_tsquery('english', ${prefixQuery}))
    )`;
  }
  return sql`ts_rank(m.search, websearch_to_tsquery('english', ${text}))`;
}

// Scopes a leg to one folder (in:inbox/sent/spam/snoozed/done/all), mirroring
// api/emails.js's folder predicates exactly so `in:` search results match
// what that folder actually shows. No `in:` filter preserves the long-
// standing default (everything except Done), now also excluding trashed
// mail, which every leg had omitted despite migration 0020's "excluded from
// all list queries" intent.
function folderClause(sql, folder) {
  if (folder === 'all') return sql`AND NOT m.is_deleted`;
  if (folder === 'done') return sql`AND NOT m.is_deleted AND m.is_archived`;
  if (folder === 'sent') return sql`AND NOT m.is_deleted AND NOT m.is_archived AND m.is_sent`;
  if (folder === 'spam') {
    return sql`AND NOT m.is_deleted AND NOT m.is_archived AND NOT m.is_sent AND ai.spam_verdict = 'spam'`;
  }
  if (folder === 'snoozed') {
    return sql`AND NOT m.is_deleted AND NOT m.is_archived AND NOT m.is_sent
               AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam' AND m.scheduled_for > now()`;
  }
  if (folder === 'inbox') {
    return sql`AND NOT m.is_deleted AND NOT m.is_archived AND NOT m.is_sent
               AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
               AND (m.scheduled_for IS NULL OR m.scheduled_for <= now())`;
  }
  return sql`AND NOT m.is_deleted AND NOT m.is_archived`;
}

// Postgres's default LIKE/ILIKE escape character is backslash. Without this,
// a literal %/_ typed by the user in a from:/to:/tag: value is interpreted as
// a wildcard instead of a literal character (e.g. tag:50%_off matching far
// more broadly than the literal string) — parameterized, so never an
// injection risk, only a matching-correctness one.
function escapeLikePattern(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Structured-operator predicates, ANDed into a leg's WHERE. Returns an empty
// fragment when no filters are set.
function filterClause(sql, filters = {}) {
  const parts = [folderClause(sql, filters.in)];
  if (filters.from) {
    const like = `%${escapeLikePattern(filters.from)}%`;
    parts.push(sql`AND (m.from_address ILIKE ${like} OR coalesce(m.from_name, '') ILIKE ${like})`);
  }
  if (filters.to) {
    const like = `%${escapeLikePattern(filters.to)}%`;
    parts.push(sql`AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        COALESCE(m.recipients->'to', '[]'::jsonb) ||
        COALESCE(m.recipients->'cc', '[]'::jsonb) ||
        COALESCE(m.recipients->'bcc', '[]'::jsonb)
      ) AS rcpt
      WHERE (CASE WHEN jsonb_typeof(rcpt) = 'string' THEN rcpt #>> '{}'
                  ELSE rcpt->>'address' END) ILIKE ${like}
         OR (CASE WHEN jsonb_typeof(rcpt) = 'string' THEN ''
                  ELSE COALESCE(rcpt->>'name', '') END) ILIKE ${like}
    )`);
  }
  if (filters.tag) {
    const like = `%${escapeLikePattern(filters.tag)}%`;
    parts.push(sql`AND EXISTS (
      SELECT 1
      FROM message_labels tagged_ml
      JOIN labels tagged_l ON tagged_l.id = tagged_ml.label_id
      WHERE tagged_ml.message_id = m.id AND tagged_l.name ILIKE ${like}
    )`);
  }
  if (filters.hasAttachment) {
    parts.push(sql`AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`);
  }
  if (filters.before) {
    parts.push(sql`AND m.sent_at < ${filters.before}::date`);
  }
  if (filters.after) {
    parts.push(sql`AND m.sent_at >= ${filters.after}::date`);
  }
  return parts.reduce((acc, part) => sql`${acc} ${part}`, sql``);
}

// Keyword leg: full-text match ranked by relevance. Requires spec.text.
export function keywordLeg(sql, userId, spec, limit) {
  const { text, prefixQuery, filters } = spec;
  return sql`
    SELECT m.id
    FROM messages m
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    WHERE m.user_id = ${userId}
      ${filterClause(sql, filters)}
      AND ${textMatch(sql, text, prefixQuery)}
    ORDER BY ${rankExpr(sql, text, prefixQuery)} DESC, m.sent_at DESC
    LIMIT ${limit}
  `;
}

// Recency leg: filter matches ordered newest-first. Used only for filters-only
// queries (e.g. `from:alice has:attachment`) that carry no relevance signal;
// for free-text search, recency is just the keyword leg's tie-breaker so it
// never competes with relevance.
export function recencyLeg(sql, userId, spec, limit) {
  const { text, prefixQuery, filters } = spec;
  const match = text ? sql`AND ${textMatch(sql, text, prefixQuery)}` : sql``;
  return sql`
    SELECT m.id
    FROM messages m
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    WHERE m.user_id = ${userId}
      ${filterClause(sql, filters)}
      ${match}
    ORDER BY m.sent_at DESC
    LIMIT ${limit}
  `;
}

// Vector leg: cosine distance over pgvector embeddings. Takes the query vector
// (already embedded) so callers can cache or skip embedding, plus the same
// structured filters so semantic results honour sender:/tag:/to:/date/in:
// operators too.
export function vectorLeg(sql, userId, vector, filters, limit) {
  return sql`
    SELECT m.id
    FROM messages m
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    WHERE m.user_id = ${userId}
      ${filterClause(sql, filters)}
      AND m.embedding IS NOT NULL
    ORDER BY m.embedding <=> ${vector}::extensions.vector
    LIMIT ${limit}
  `;
}
