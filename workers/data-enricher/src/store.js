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
 * Whether today's round-up (UK day) is already stored with something in it.
 * Its sources cover the previous UK day, so rebuilding it on every hourly run
 * would only spend OpenAI calls to produce the same card again.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function hasNewsForUkToday(sql, userId) {
  const rows = await sql`
    SELECT EXISTS (
      SELECT 1 FROM summaries
      WHERE user_id = ${userId}
        AND kind = ${NEWS_KIND}
        AND message_id IS NULL
        AND (created_at AT TIME ZONE 'Europe/London')::date
          = (now() AT TIME ZONE 'Europe/London')::date
        AND jsonb_typeof(raw -> 'sections') = 'array'
        AND jsonb_array_length(raw -> 'sections') > 0
    ) AS fresh
  `;
  return rows[0]?.fresh === true;
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
