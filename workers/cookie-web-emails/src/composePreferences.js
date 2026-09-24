// Composer preferences are one versioned document in users.prefs. A conditional
// UPDATE is the compare-and-swap: PostgreSQL rechecks the revision after taking
// the user-row lock, so two browsers cannot both commit the same base revision.
const MAX_SIGNATURE_LENGTH = 64 * 1024;
const MAX_SNIPPETS = 50;
const MAX_SNIPPET_HTML_LENGTH = 64 * 1024;
const RESERVED_NAMES = new Set([
  'generate',
  'heading',
  'bullet',
  'numbered',
  'bold',
  'quote',
  'divider',
]);
const NO_STORE = { 'Cache-Control': 'private, no-store' };

/** @typedef {{revision: number, signatureHtml: string, snippets: {id: string, name: string, html: string}[]}} ComposePreferencesInput */

/** @param {unknown} stored */
export function parseComposePreferences(stored) {
  const value = /** @type {Record<string, any>} */ (
    stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  );
  return {
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    signatureHtml: typeof value.signatureHtml === 'string' ? value.signatureHtml : '',
    snippets: Array.isArray(value.snippets) ? value.snippets : [],
  };
}

/** @param {unknown} body @returns {body is ComposePreferencesInput} */
export function validateComposePreferences(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = /** @type {Record<string, any>} */ (body);
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    value.revision >= Number.MAX_SAFE_INTEGER
  )
    return false;
  if (typeof value.signatureHtml !== 'string' || value.signatureHtml.length > MAX_SIGNATURE_LENGTH)
    return false;
  if (!Array.isArray(value.snippets) || value.snippets.length > MAX_SNIPPETS) return false;
  const ids = new Set();
  const names = new Set();
  for (const snippet of value.snippets) {
    if (!snippet || typeof snippet !== 'object' || Array.isArray(snippet)) return false;
    if (typeof snippet.id !== 'string' || !snippet.id || snippet.id.length > 128) return false;
    if (
      typeof snippet.name !== 'string' ||
      snippet.name.length > 50 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(snippet.name) ||
      RESERVED_NAMES.has(snippet.name)
    )
      return false;
    if (
      typeof snippet.html !== 'string' ||
      !snippet.html.trim() ||
      snippet.html.length > MAX_SNIPPET_HTML_LENGTH
    )
      return false;
    if (ids.has(snippet.id) || names.has(snippet.name)) return false;
    ids.add(snippet.id);
    names.add(snippet.name);
  }
  return true;
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export async function getComposePreferences(sql, userId) {
  const [row] =
    await sql`SELECT prefs -> 'composePreferences' AS preferences FROM users WHERE id = ${userId}`;
  if (!row) return Response.json({ error: 'User not found' }, { status: 404, headers: NO_STORE });
  return Response.json(parseComposePreferences(row.preferences), { headers: NO_STORE });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {unknown} body */
export async function putComposePreferences(sql, userId, body) {
  if (!validateComposePreferences(body)) {
    return Response.json(
      { error: 'Invalid compose preferences or revision' },
      { status: 400, headers: NO_STORE },
    );
  }
  const next = {
    revision: body.revision + 1,
    signatureHtml: body.signatureHtml,
    snippets: body.snippets.map(({ id, name, html }) => ({ id, name, html })),
  };
  const [saved] = await sql`
    UPDATE users
    SET prefs = jsonb_set(coalesce(prefs, '{}'::jsonb), '{composePreferences}', ${sql.json(next)}, true)
    WHERE id = ${userId}
      AND coalesce(prefs -> 'composePreferences' ->> 'revision', '0') = ${String(body.revision)}
    RETURNING prefs -> 'composePreferences' AS preferences
  `;
  if (saved)
    return Response.json(parseComposePreferences(saved.preferences), { headers: NO_STORE });
  const [current] =
    await sql`SELECT prefs -> 'composePreferences' AS preferences FROM users WHERE id = ${userId}`;
  if (!current)
    return Response.json({ error: 'User not found' }, { status: 404, headers: NO_STORE });
  return Response.json(
    {
      error: 'Compose preferences changed in another session',
      current: parseComposePreferences(current.preferences),
    },
    { status: 409, headers: NO_STORE },
  );
}
