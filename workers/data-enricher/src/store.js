import { DIGEST_KIND, DIGEST_PROMPT_VERSION, TRIAGE_POLICY_SOURCE } from './digest.js';
import { NEWS_KIND, NEWS_PROMPT_VERSION } from './news.js';
import { normalizeEnrichmentSettings } from '../../../shared/enrichmentSettings.js';

/** @typedef {import('postgres').Sql | import('postgres').TransactionSql} SqlClient */

// Every jsonb write below uses sql.json(value), never JSON.stringify(value)
// bound with a trailing ::jsonb cast: postgres.js sends an already-stringified
// parameter as jsonb text, which Postgres parses back into a jsonb *string
// scalar* rather than an object, silently breaking any code that reads into it
// (this is what broke AI Today's digest/news raw.topics / raw.sections).

/**
 * @typedef {{
 *   source: 'email',
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
 * @param {SqlClient} sql
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
 * @param {SqlClient} sql
 * @param {string} userId
 * @param {TaskRecord[]} tasks
 * @returns {Promise<number>}
 */
export async function storeTasks(sql, userId, tasks) {
  if (tasks.length === 0) return 0;

  const rows = tasks.map((task) => ({
    source: task.source,
    external_id: task.externalId,
    content: task.content,
    description: task.description ?? null,
    due_date: task.dueDate ?? null,
    priority: task.priority ?? null,
    url: task.url ?? null,
    message_id: task.messageId ?? null,
    raw: task.raw ?? {},
  }));

  await sql`
    INSERT INTO tasks (
      user_id, source, external_id, content, description,
      due_date, priority, url, message_id, raw
    )
    SELECT ${userId}::uuid, row.source, row.external_id, row.content, row.description,
           row.due_date::date, row.priority::smallint, row.url, row.message_id::uuid, row.raw
    FROM jsonb_to_recordset(${sql.json(/** @type {any} */ (rows))}) AS row(
      source text, external_id text, content text, description text,
      due_date text, priority smallint, url text, message_id text, raw jsonb
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
  return tasks.length;
}

/**
 * @param {SqlClient} sql
 * @param {string} userId
 * @param {{messageId: string, summary: string, kind?: string, model?: string | null, raw?: unknown}} record
 */
export async function storeSummary(sql, userId, record) {
  await sql`
    INSERT INTO summaries (user_id, message_id, kind, summary, model, raw)
    VALUES (
      ${userId}, ${record.messageId}, ${record.kind ?? 'email_tasks'},
      ${record.summary}, ${record.model ?? null}, ${sql.json(/** @type {any} */ (record.raw ?? {}))}
    )
    ON CONFLICT (user_id, message_id, kind) WHERE message_id IS NOT NULL
    DO UPDATE SET
      summary = EXCLUDED.summary,
      model = EXCLUDED.model,
      raw = EXCLUDED.raw
  `;
}

/**
 * Store every artifact derived from one email as a unit. The summary is the
 * marker used by fetchImportantMessages to skip completed analysis, so it is
 * deliberately written last and committed only with all task upserts.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{messageId: string, summary: string, kind?: string, model?: string | null, raw?: unknown}} summary
 * @param {TaskRecord[]} tasks
 */
export async function storeEmailAnalysis(sql, userId, summary, tasks) {
  return sql.begin(async (tx) => {
    await storeTasks(tx, userId, tasks);
    await storeSummary(tx, userId, summary);
  });
}

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
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} [fallbackModel]
 */
export async function fetchEnrichmentSettings(sql, userId, fallbackModel) {
  const rows = await sql`
    SELECT prefs -> 'enrichmentSettings' AS enrichment_settings
    FROM users
    WHERE id = ${userId}
  `;
  return normalizeEnrichmentSettings(rows[0]?.enrichment_settings, fallbackModel);
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} kind
 * @param {string} summary
 * @param {string | null | undefined} model
 * @param {unknown} raw
 * @returns {Promise<string>}
 */
async function replaceSingletonSummary(sql, userId, kind, summary, model, raw) {
  return sql.begin(async (tx) => {
    // Two refreshes for the same user/kind must not delete one another's new
    // row. A transaction-scoped advisory lock serializes only that tiny pair.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${kind}`}, 0))`;
    const [row] = await tx`
      INSERT INTO summaries (user_id, message_id, kind, summary, model, raw)
      VALUES (${userId}, NULL, ${kind}, ${summary}, ${model ?? null}, ${tx.json(/** @type {any} */ (raw))})
      RETURNING id
    `;
    await tx`
      DELETE FROM summaries
      WHERE user_id = ${userId}
        AND kind = ${kind}
        AND message_id IS NULL
        AND id <> ${row.id}
    `;
    return row.id;
  });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{sections: unknown[]}} news
 * @param {string | null} [model]
 */
export async function storeNews(sql, userId, news, model) {
  return replaceSingletonSummary(sql, userId, NEWS_KIND, '', model, {
    sections: news.sections,
    prompt_version: NEWS_PROMPT_VERSION,
  });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{overview: string, topics: unknown[], noise?: {count: number, categories: unknown[]}}} digest
 * @param {string | null} [model]
 * @param {string[]} [sourceMessageIds] Includes noise contributors for live screening checks.
 */
export async function storeDigest(sql, userId, digest, model, sourceMessageIds) {
  return replaceSingletonSummary(sql, userId, DIGEST_KIND, digest.overview, model, {
    topics: digest.topics,
    noise: digest.noise ?? { count: 0, categories: [] },
    ...(sourceMessageIds ? { source_message_ids: sourceMessageIds } : {}),
    prompt_version: DIGEST_PROMPT_VERSION,
    policy_source: TRIAGE_POLICY_SOURCE,
  });
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export async function fetchGithubPersonalisation(sql, userId) {
  const rows = await sql`
    SELECT (coalesce(prefs -> 'personaliseGithub', 'false'::jsonb) = 'true'::jsonb) AS enabled
    FROM users WHERE id = ${userId}
  `;
  return rows[0]?.enabled === true;
}
