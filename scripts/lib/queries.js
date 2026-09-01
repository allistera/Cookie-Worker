// SQL query builders for reindex-meili.js and repair-search-drift.js.
//
// Each *Page function selects exactly the columns its target's descriptor
// (shared/meili/documents.js or shared/meili/messages.js) reads in
// toDocument. The messages queries carry the same LEFT JOIN on message_ai
// and label aggregation as shared/meiliSync.js, so is_spam and labels come
// out right.

/**
 * One keyset-paginated page of documents rows, ordered by id so the last
 * row's id becomes the next page's cursor. Pass afterId: null for the first
 * page.
 *
 * @param {import('postgres').Sql} sql
 * @param {{afterId: string | null, limit: number}} page
 */
export function documentsPage(sql, { afterId, limit }) {
  const cursor = afterId ? sql`AND id > ${afterId}` : sql``;
  return sql`
    SELECT id, user_id, title, content_text, tags, starred, updated_at
    FROM documents
    WHERE true
      ${cursor}
    ORDER BY id
    LIMIT ${limit}
  `;
}

/**
 * One keyset-paginated page of messages rows, ordered by id.
 *
 * @param {import('postgres').Sql} sql
 * @param {{afterId: string | null, limit: number}} page
 */
export function messagesPage(sql, { afterId, limit }) {
  const cursor = afterId ? sql`AND m.id > ${afterId}` : sql``;
  return sql`
    SELECT
      m.id, m.user_id, m.from_name, m.from_address, m.recipients, m.subject, m.body_text,
      m.sent_at, m.scheduled_for, m.is_unread, m.is_starred, m.is_archived, m.is_sent, m.is_deleted,
      ai.spam_verdict,
      EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
      COALESCE(
        json_agg(json_build_object('name', l.name) ORDER BY l.name)
          FILTER (WHERE l.id IS NOT NULL),
        '[]'
      ) AS labels
    FROM messages m
    LEFT JOIN message_labels ml ON ml.message_id = m.id
    LEFT JOIN labels l ON l.id = ml.label_id
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    WHERE true
      ${cursor}
    GROUP BY m.id, ai.spam_verdict
    ORDER BY m.id
    LIMIT ${limit}
  `;
}

/**
 * One page of documents rows Meilisearch never received or that have since
 * changed — search_indexed_at is NULL or behind updated_at. Ordered by
 * updated_at (oldest drift first); the caller loops until this comes back
 * empty, which it does naturally as stamping shrinks the WHERE clause.
 *
 * @param {import('postgres').Sql} sql
 * @param {{limit: number}} page
 */
export function documentsDriftPage(sql, { limit }) {
  return sql`
    SELECT id, user_id, title, content_text, tags, starred, updated_at
    FROM documents
    WHERE search_indexed_at IS NULL OR search_indexed_at < updated_at
    ORDER BY updated_at
    LIMIT ${limit}
  `;
}

/**
 * Drift page for messages. Unlike documentsDriftPage, this can only ask for
 * "never indexed" — messages has no updated_at column (Cookie-Web migration
 * 0001 gives messages only created_at; see Cookie-Web migration
 * 0055_search_indexed_at.sql for the full explanation and
 * messages_search_drift_idx, the partial index this predicate must match
 * exactly to be used). Ordered by created_at, matching that index.
 *
 * The absence of updated_at is no longer a staleness source. Every handler
 * that changes an indexed field now sets search_indexed_at back to NULL in
 * the same statement (or transaction) as the change itself, so an edited
 * row re-enters this predicate without needing a modification timestamp to
 * compare against. The writer then syncs immediately and stamps it again;
 * this query is what catches the ones whose sync never landed.
 *
 * @param {import('postgres').Sql} sql
 * @param {{limit: number}} page
 */
export function messagesDriftPage(sql, { limit }) {
  return sql`
    SELECT
      m.id, m.user_id, m.from_name, m.from_address, m.recipients, m.subject, m.body_text,
      m.sent_at, m.scheduled_for, m.is_unread, m.is_starred, m.is_archived, m.is_sent, m.is_deleted,
      ai.spam_verdict,
      EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
      COALESCE(
        json_agg(json_build_object('name', l.name) ORDER BY l.name)
          FILTER (WHERE l.id IS NOT NULL),
        '[]'
      ) AS labels
    FROM messages m
    LEFT JOIN message_labels ml ON ml.message_id = m.id
    LEFT JOIN labels l ON l.id = ml.label_id
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    WHERE m.search_indexed_at IS NULL
    GROUP BY m.id, ai.spam_verdict
    ORDER BY m.created_at
    LIMIT ${limit}
  `;
}

/**
 * One keyset-paginated page of top-level task rows. Sub-tasks are not their
 * own Meilisearch documents — each page row aggregates its direct children's
 * titles into the `subtasks` array TASKS_INDEX.toDocument reads (the same
 * shape cookie-web-tasks' taskItemMeiliSync.js pushes at write time).
 *
 * @param {import('postgres').Sql} sql
 * @param {{afterId: string | null, limit: number}} page
 */
export function taskItemsPage(sql, { afterId, limit }) {
  const cursor = afterId ? sql`AND t.id > ${afterId}` : sql``;
  return sql`
    SELECT t.id, t.user_id, t.content, t.description, t.completed_at, t.updated_at,
           COALESCE(array_agg(c.content ORDER BY c.created_at) FILTER (WHERE c.id IS NOT NULL),
                    ARRAY[]::text[]) AS subtasks
    FROM task_items t
    LEFT JOIN task_items c ON c.parent_id = t.id
    WHERE t.parent_id IS NULL
      ${cursor}
    GROUP BY t.id
    ORDER BY t.id
    LIMIT ${limit}
  `;
}

/**
 * Drift page for task items. Only the top-level row carries the stamp, but a
 * sub-task write that never reached Meilisearch must still drift its parent
 * — hence the EXISTS leg comparing children's updated_at against the
 * parent's stamp. No partial index backs this (unlike documents/messages):
 * the correlated EXISTS can't live in an index predicate, and task_items is
 * a small personal table.
 *
 * @param {import('postgres').Sql} sql
 * @param {{limit: number}} page
 */
export function taskItemsDriftPage(sql, { limit }) {
  return sql`
    SELECT t.id, t.user_id, t.content, t.description, t.completed_at, t.updated_at,
           COALESCE(array_agg(c.content ORDER BY c.created_at) FILTER (WHERE c.id IS NOT NULL),
                    ARRAY[]::text[]) AS subtasks
    FROM task_items t
    LEFT JOIN task_items c ON c.parent_id = t.id
    WHERE t.parent_id IS NULL
      AND (t.search_indexed_at IS NULL
           OR t.search_indexed_at < t.updated_at
           OR EXISTS (SELECT 1 FROM task_items s
                      WHERE s.parent_id = t.id AND s.updated_at > t.search_indexed_at))
    GROUP BY t.id
    ORDER BY t.updated_at
    LIMIT ${limit}
  `;
}

export const PAGE_QUERIES = {
  documents: documentsPage,
  messages: messagesPage,
  task_items: taskItemsPage,
};
export const DRIFT_QUERIES = {
  documents: documentsDriftPage,
  messages: messagesDriftPage,
  task_items: taskItemsDriftPage,
};

/**
 * Stamps search_indexed_at = now() on every pushed id, so the drift sweep
 * (and a re-run of reindex-meili.js) sees these rows as already indexed.
 *
 * @param {import('postgres').Sql} sql
 * @param {'documents' | 'messages' | 'task_items'} target
 * @param {string[]} ids
 */
export function stampIndexed(sql, target, ids) {
  if (target === 'documents') {
    return sql`UPDATE documents SET search_indexed_at = now() WHERE id = ANY(${ids}::uuid[])`;
  }
  if (target === 'task_items') {
    return sql`UPDATE task_items SET search_indexed_at = now() WHERE id = ANY(${ids}::uuid[])`;
  }
  return sql`UPDATE messages SET search_indexed_at = now() WHERE id = ANY(${ids}::uuid[])`;
}
