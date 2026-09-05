import { addDocuments, meiliAvailable } from './meili.js';
import { MESSAGES_INDEX } from './meili/messages.js';

// Meilisearch accepts or rejects an addDocuments payload as a whole, so one
// oversized or malformed document would otherwise cost every other document
// in the call — and with it every id's stamp, leaving the drift sweep to
// reselect the same rows and fail the same way on every tick, forever. Push
// in chunks so a bad document can only cost its own chunk.
export const MEILI_CHUNK_SIZE = 50;

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort sync of one message to Meilisearch. Reads the authoritative row
 * from Postgres (including labels and, via a LEFT JOIN message_ai, the spam
 * verdict MESSAGES_INDEX.toDocument needs for is_spam) and pushes a
 * document. Failures are logged and ignored so that message
 * delivery/forwarding is never blocked by search.
 *
 * Never throws: callers run this inside ctx.waitUntil on paths where a
 * rejection would break mail delivery. It reports what happened through its
 * return value instead — `indexed` counts documents Meilisearch accepted,
 * `failed` counts documents it did not.
 *
 * @param {import('postgres').Sql} sql
 * @param {any} env
 * @param {string} messageUuid
 * @returns {Promise<{indexed: number, failed: number}>}
 */
export async function syncMessageToMeili(sql, env, messageUuid) {
  if (!meiliAvailable(env)) return { indexed: 0, failed: 0 };

  try {
    const [row] = await sql`
    SELECT
      m.id,
      m.xmin::text AS row_version,
      m.user_id,
      m.from_name,
      m.from_address,
      m.recipients,
      m.subject,
      m.body_text,
      m.sent_at,
      m.scheduled_for,
      m.is_unread,
      m.is_starred,
      m.is_archived,
      m.is_sent,
      m.is_deleted,
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
    WHERE m.id = ${messageUuid}
    GROUP BY m.id, ai.spam_verdict
  `;

    if (!row) {
      console.log(JSON.stringify({ event: 'meili_sync_missing', message_id: messageUuid }));
      return { indexed: 0, failed: 0 };
    }

    const result = await addDocuments(env, MESSAGES_INDEX, [row]);
    await stampIndexed(sql, [String(row.id)], [String(row.row_version)]);
    console.log(
      JSON.stringify({
        event: 'meili_synced',
        message_id: messageUuid,
        task_uid: result?.taskUid,
      }),
    );
    return { indexed: 1, failed: 0 };
  } catch (err) {
    console.log(
      JSON.stringify({
        event: 'meili_sync_failed',
        message_id: messageUuid,
        error: errorText(err),
      }),
    );
    return { indexed: 0, failed: 1 };
  }
}

/**
 * Batch form of syncMessageToMeili, for callers that mutate many messages at
 * once (bulk archive/star/label/trash) and would otherwise fire N round
 * trips to Postgres and Meilisearch, and for the drift sweep. Selects every
 * row in one query and pushes them in MEILI_CHUNK_SIZE-sized addDocuments
 * calls; a chunk Meilisearch rejects is counted as failed and leaves its ids
 * unstamped (so the sweep retries them) without stopping the chunks after
 * it. Some ids may not come back from the SELECT at all (deleted between the
 * mutation and this sync, or never existed) — search_indexed_at is only
 * stamped for the ids that did, same as the single-message path only stamps
 * when it found a row.
 *
 * Never throws; see syncMessageToMeili for the return value.
 *
 * @param {import('postgres').Sql} sql
 * @param {any} env
 * @param {string[]} messageUuids
 * @returns {Promise<{indexed: number, failed: number}>}
 */
export async function syncMessagesToMeili(sql, env, messageUuids) {
  if (!messageUuids.length || !meiliAvailable(env)) return { indexed: 0, failed: 0 };

  /** @type {any[]} */
  let rows;
  try {
    rows = await sql`
    SELECT
      m.id,
      m.xmin::text AS row_version,
      m.user_id,
      m.from_name,
      m.from_address,
      m.recipients,
      m.subject,
      m.body_text,
      m.sent_at,
      m.scheduled_for,
      m.is_unread,
      m.is_starred,
      m.is_archived,
      m.is_sent,
      m.is_deleted,
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
    WHERE m.id = ANY(${messageUuids})
    GROUP BY m.id, ai.spam_verdict
  `;
  } catch (err) {
    console.log(
      JSON.stringify({
        event: 'meili_sync_failed',
        count: messageUuids.length,
        error: errorText(err),
      }),
    );
    return { indexed: 0, failed: messageUuids.length };
  }

  if (!rows.length) return { indexed: 0, failed: 0 };

  /** @type {string[]} */
  const syncedIds = [];
  /** @type {string[]} */
  const syncedVersions = [];
  let failed = 0;
  /** @type {any} */
  let taskUid;

  for (let i = 0; i < rows.length; i += MEILI_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + MEILI_CHUNK_SIZE);
    try {
      const result = await addDocuments(env, MESSAGES_INDEX, chunk);
      taskUid = result?.taskUid;
      for (const row of chunk) {
        syncedIds.push(String(row.id));
        syncedVersions.push(String(row.row_version));
      }
    } catch (err) {
      // Only this chunk's ids stay NULL; the sweep picks them up again.
      failed += chunk.length;
      console.log(
        JSON.stringify({
          event: 'meili_sync_failed',
          count: chunk.length,
          error: errorText(err),
        }),
      );
    }
  }

  if (!syncedIds.length) return { indexed: 0, failed };

  try {
    await stampIndexed(sql, syncedIds, syncedVersions);
    console.log(
      JSON.stringify({
        event: 'meili_synced',
        count: syncedIds.length,
        task_uid: taskUid,
      }),
    );
  } catch (err) {
    // The documents are in Meilisearch, so they count as indexed; the rows
    // simply stay NULL and get swept again.
    console.log(
      JSON.stringify({
        event: 'meili_sync_failed',
        count: syncedIds.length,
        error: errorText(err),
      }),
    );
  }

  return { indexed: syncedIds.length, failed };
}

/**
 * Stamps search_indexed_at on rows that have not changed since they were
 * read, using xmin — the transaction that last wrote the row — as a version
 * token. Any UPDATE between the SELECT above and this stamp bumps xmin, so
 * the stamp is cleared and search_indexed_at becomes NULL for the drift sweep
 * to repair. Clearing is essential if an older indexing job finishes after
 * a newer one was already stamped: its late payload can overwrite the index.
 *
 * `WHERE search_indexed_at IS NULL` would not do: a writer marks the row
 * NULL before firing its own sync, so a row raced by a second mutation is
 * NULL at both ends of the window, and the older sync's stamp would erase
 * the newer mutation's mark permanently — the row would be indexed without
 * the newer change and never selected again.
 *
 * @param {import('postgres').Sql} sql
 * @param {string[]} ids
 * @param {string[]} versions same order as ids
 */
function stampIndexed(sql, ids, versions) {
  return sql`
    UPDATE messages m
    SET search_indexed_at = CASE WHEN m.xmin::text = v.row_version THEN now() ELSE NULL END
    FROM unnest(${ids}::uuid[], ${versions}::text[]) AS v(id, row_version)
    WHERE m.id = v.id
  `;
}
