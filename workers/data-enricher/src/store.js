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
