import {
  AUTO_ARCHIVE_CATEGORIES,
  autoArchiveSettings,
  updateAutoArchive,
} from '../../../shared/autoArchive.js';

/** @param {import('postgres').Sql} sql @param {string} userId */
export async function getAutoArchive(sql, userId) {
  const [row] =
    await sql`SELECT prefs -> 'autoArchive' AS settings FROM users WHERE id = ${userId}`;
  return Response.json({ autoArchive: autoArchiveSettings(row?.settings) });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {any} body */
export async function putAutoArchive(sql, userId, body) {
  const flags = body?.autoArchive;
  if (
    !flags ||
    Array.isArray(flags) ||
    Object.keys(flags).length !== AUTO_ARCHIVE_CATEGORIES.length ||
    !AUTO_ARCHIVE_CATEGORIES.every((category) => typeof flags[category] === 'boolean')
  ) {
    return Response.json(
      { error: 'autoArchive must contain marketing, coldPitches and socialNoise booleans' },
      { status: 400 },
    );
  }
  const saved = await sql.begin(async (tx) => {
    const [row] = await tx`
      SELECT prefs -> 'autoArchive' AS settings, clock_timestamp() AS activated_at
      FROM users WHERE id = ${userId} FOR UPDATE
    `;
    if (!row) return null;
    const settings = updateAutoArchive(
      row.settings,
      flags,
      new Date(row.activated_at).toISOString(),
    );
    await tx`
      UPDATE users SET prefs = coalesce(prefs, '{}'::jsonb) || ${tx.json({ autoArchive: settings })}
      WHERE id = ${userId}
    `;
    return settings;
  });
  if (!saved) return Response.json({ error: 'User not found' }, { status: 404 });
  return Response.json({ autoArchive: autoArchiveSettings(saved) });
}
