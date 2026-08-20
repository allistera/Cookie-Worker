// Ported from Cookie-Web's api/_lib/interests.js — pure SQL/validation, no
// Node APIs. (req, res) handling becomes returning a Response.

// Personalisation topics for AI Today's news section. Unlike the signature and
// snippets, these cannot live in localStorage: the data-enricher Worker reads
// them at 05:00 UTC with no browser running. They go in users.prefs, the jsonb
// column declared for settings-modal preferences.
export const MAX_INTERESTS = 20;
export const MAX_INTEREST_LENGTH = 60;

/** @param {import('postgres').Sql} sql @param {string} userId */
export function fetchInterests(sql, userId) {
  return sql`
    SELECT coalesce(u.prefs -> 'interests', '[]'::jsonb) AS interests
    FROM users u
    WHERE u.id = ${userId}
  `;
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {string[]} interests */
export function saveInterests(sql, userId, interests) {
  // sql.json (not a manually JSON.stringify'd string cast with ::jsonb) is
  // required here: postgres.js sends a pre-stringified string parameter as
  // jsonb text that Postgres parses back into a jsonb *string scalar*, not an
  // object, which turns the || below into an array-append instead of a
  // key merge and silently drops every previous save.
  return sql`
    UPDATE users
    SET prefs = coalesce(prefs, '{}'::jsonb) || ${sql.json({ interests })}
    WHERE id = ${userId}
    RETURNING coalesce(prefs -> 'interests', '[]'::jsonb) AS interests
  `;
}

// Trim, drop blanks, de-duplicate case-insensitively, and bound both the list
// and each entry. Returns null when the payload is not a list of strings at
// all, which the caller reports as a 400 rather than silently storing nothing.
/** @param {any} input */
export function normalizeInterests(input) {
  if (!Array.isArray(input)) return null;
  if (input.some((entry) => !(entry?.trim instanceof Function))) return null;

  const seen = new Set();
  const interests = [];
  for (const entry of input) {
    const trimmed = entry.trim().slice(0, MAX_INTEREST_LENGTH);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    interests.push(trimmed);
    if (interests.length === MAX_INTERESTS) break;
  }
  return interests;
}

// GET /tasks/interests — the topics the news section is ranked against.
/** @param {import('postgres').Sql} sql @param {string} userId */
export async function getInterests(sql, userId) {
  const [row] = await fetchInterests(sql, userId);
  return Response.json({ interests: row?.interests ?? [] });
}

// PUT /tasks/interests — an empty list is valid and means "don't personalise".
/** @param {import('postgres').Sql} sql @param {string} userId @param {any} body */
export async function putInterests(sql, userId, body) {
  const interests = normalizeInterests(body?.interests);
  if (!interests) {
    return Response.json({ error: 'interests must be an array of strings' }, { status: 400 });
  }

  const [row] = await saveInterests(sql, userId, interests);
  if (!row) return Response.json({ error: 'User not found' }, { status: 404 });
  return Response.json({ interests: row.interests });
}
