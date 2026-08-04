import { DIGEST_KIND, DIGEST_PROMPT_VERSION } from './digest.js';
import { NEWS_KIND, NEWS_PROMPT_VERSION } from './news.js';

/**
 * @typedef {{
 *   source: 'todoist' | 'email',
 *   externalId: string,
 *   content: string,
 *   description?: string | null,
 *   dueDate?: string | null,
 *   priority?: number | null,
 *   url?: string | null,
 *   messageId?: string | null,
 *   raw?: unknown,
 * }} TaskRecord
 */

/**
 * @param {import('postgres').Sql} sql
 * @param {string} ownerEmail
 * @returns {Promise<string>}
 */
export async function lookupUserId(sql, ownerEmail) {
  const rows = await sql`
    SELECT id FROM users
    WHERE users.email = ${ownerEmail}
    ORDER BY users.created_at
    LIMIT 1
  `;
  if (!rows[0]) throw new Error('no users row matches OWNER_EMAIL; nothing stored');
  return rows[0].id;
}

/**
 * Upsert gathered tasks so the daily cron stays idempotent: re-gathering the
 * same task refreshes its fields and gathered_at instead of duplicating it.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {TaskRecord[]} tasks
 * @returns {Promise<number>}
 */
export async function storeTasks(sql, userId, tasks) {
  for (const task of tasks) {
    await sql`
      INSERT INTO tasks (
        user_id, source, external_id, content, description,
        due_date, priority, url, message_id, raw
      )
      VALUES (
        ${userId}, ${task.source}, ${task.externalId}, ${task.content},
        ${task.description ?? null}, ${task.dueDate ?? null},
        ${task.priority ?? null}, ${task.url ?? null},
        ${task.messageId ?? null}, ${JSON.stringify(task.raw ?? {})}
      )
      ON CONFLICT (user_id, source, external_id) DO UPDATE SET
        content = EXCLUDED.content,
        description = EXCLUDED.description,
        due_date = EXCLUDED.due_date,
        priority = EXCLUDED.priority,
        url = EXCLUDED.url,
        message_id = EXCLUDED.message_id,
        raw = EXCLUDED.raw,
        gathered_at = now()
    `;
  }
  return tasks.length;
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{messageId: string, summary: string, kind?: string, model?: string | null, raw?: unknown}} record
 */
export async function storeSummary(sql, userId, record) {
  await sql`
    INSERT INTO summaries (user_id, message_id, kind, summary, model, raw)
    VALUES (
      ${userId}, ${record.messageId}, ${record.kind ?? 'email_tasks'},
      ${record.summary}, ${record.model ?? null}, ${JSON.stringify(record.raw ?? {})}
    )
    ON CONFLICT (user_id, message_id, kind) WHERE message_id IS NOT NULL
    DO UPDATE SET
      summary = EXCLUDED.summary,
      model = EXCLUDED.model,
      raw = EXCLUDED.raw
  `;
}

/**
 * Replace the stored daily digest. Digest rows carry no message_id, so the
 * partial unique index on summaries does not apply to them and each run would
 * otherwise append. Insert first and prune afterwards: a failed insert leaves
 * yesterday's digest readable, and a failed prune only leaves a superseded row
 * that the newest-first read ignores.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{overview: string, topics: unknown[]}} digest
 * @param {string | null} [model]
 * @returns {Promise<string>}
 */
/**
 * The reader's personalisation topics from users.prefs, written by Cookie-Web's
 * settings pane. Absent or malformed prefs mean "do not personalise".
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
export async function fetchInterests(sql, userId) {
  const rows = await sql`
    SELECT coalesce(prefs -> 'interests', '[]'::jsonb) AS interests
    FROM users
    WHERE id = ${userId}
  `;
  const interests = rows[0]?.interests;
  return Array.isArray(interests) ? interests.filter((i) => typeof i === 'string') : [];
}

/**
 * Replace the stored daily news, on the same insert-then-prune footing as
 * storeDigest.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{sections: unknown[]}} news
 * @param {string | null} [model]
 * @returns {Promise<string>}
 */
export async function storeNews(sql, userId, news, model) {
  const raw = JSON.stringify({ sections: news.sections, prompt_version: NEWS_PROMPT_VERSION });
  const [row] = await sql`
    INSERT INTO summaries (user_id, message_id, kind, summary, model, raw)
    VALUES (${userId}, NULL, ${NEWS_KIND}, '', ${model ?? null}, ${raw})
    RETURNING id
  `;
  await sql`
    DELETE FROM summaries
    WHERE user_id = ${userId}
      AND kind = ${NEWS_KIND}
      AND message_id IS NULL
      AND id <> ${row.id}
  `;
  return row.id;
}

export async function storeDigest(sql, userId, digest, model) {
  const raw = JSON.stringify({ topics: digest.topics, prompt_version: DIGEST_PROMPT_VERSION });
  const [row] = await sql`
    INSERT INTO summaries (user_id, message_id, kind, summary, model, raw)
    VALUES (${userId}, NULL, ${DIGEST_KIND}, ${digest.overview}, ${model ?? null}, ${raw})
    RETURNING id
  `;
  await sql`
    DELETE FROM summaries
    WHERE user_id = ${userId}
      AND kind = ${DIGEST_KIND}
      AND message_id IS NULL
      AND id <> ${row.id}
  `;
  return row.id;
}
