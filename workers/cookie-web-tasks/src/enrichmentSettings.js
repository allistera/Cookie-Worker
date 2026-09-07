import {
  normalizeEnrichmentSettings,
  validateEnrichmentSettings,
} from '../../../shared/enrichmentSettings.js';

/** @param {import('postgres').Sql} sql @param {string} userId */
export function fetchEnrichmentSettings(sql, userId) {
  return sql`
    SELECT prefs -> 'enrichmentSettings' AS enrichment_settings
    FROM users
    WHERE id = ${userId}
  `;
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {any} enrichmentSettings */
export function saveEnrichmentSettings(sql, userId, enrichmentSettings) {
  return sql`
    UPDATE users
    SET prefs = coalesce(prefs, '{}'::jsonb) || ${sql.json({ enrichmentSettings })}
    WHERE id = ${userId}
    RETURNING prefs -> 'enrichmentSettings' AS enrichment_settings
  `;
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export async function getEnrichmentSettings(sql, userId) {
  const [row] = await fetchEnrichmentSettings(sql, userId);
  return Response.json({
    enrichmentSettings: normalizeEnrichmentSettings(row?.enrichment_settings),
  });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {any} body */
export async function putEnrichmentSettings(sql, userId, body) {
  const parsed = validateEnrichmentSettings(body?.enrichmentSettings);
  if (parsed.error) return Response.json({ error: parsed.error }, { status: 400 });
  if (!parsed.value) return Response.json({ error: 'Invalid settings' }, { status: 400 });
  const [row] = await saveEnrichmentSettings(sql, userId, parsed.value);
  if (!row) return Response.json({ error: 'User not found' }, { status: 404 });
  return Response.json({
    enrichmentSettings: normalizeEnrichmentSettings(row.enrichment_settings),
  });
}
