import { parseFederatedSearchQuery } from './queryParse.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const FOLDERS = new Set(['all', 'inbox', 'sent', 'spam', 'snoozed', 'done']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_VIEWS = 30;
const MAX_QUERY_LENGTH = 470;

/**
 * Saved views deliberately accept a strict subset of the scoped mail-search parser.
 * That parser treats unknown/malformed operators as free text, which would
 * make a persisted view appear to filter when it does not.
 * @param {string} query
 * @returns {string | null} User-facing validation error.
 */
export function savedQueryError(query) {
  if (!query || query.length > MAX_QUERY_LENGTH)
    return `Enter a search query of 1–${MAX_QUERY_LENGTH} characters.`;

  const tokens = [];
  let token = '';
  let quoted = false;
  for (const char of query) {
    if (char === '"') quoted = !quoted;
    if (/\s/.test(char) && !quoted) {
      if (token) tokens.push(token);
      token = '';
    } else {
      token += char;
    }
  }
  if (quoted) return 'Close the quotation mark in the search query.';
  if (token) tokens.push(token);

  const seen = new Set();
  let hasCriterion = false;
  for (const part of tokens) {
    if (/^(AND|OR|NOT)$/i.test(part))
      return 'Boolean AND, OR, and NOT are not supported in saved views.';
    const operator = /^([a-z][\w-]*):(.*)$/i.exec(part);
    if (!operator) {
      // Scoped search recognizes operators anywhere in a token, including
      // is:starred. A prefixed form would validate as text but execute as a
      // positive filter.
      if (Object.keys(parseFederatedSearchQuery(part).filters).length)
        return 'Remove the unsupported prefix before a search operator.';
      if (part.includes('"') && !/^"[^":]*"$/.test(part))
        return 'Use quotation marks around a whole phrase or an operator value.';
      hasCriterion = true;
      continue;
    }
    const key = operator[1].toLowerCase();
    if (key === 'in') return 'Choose the folder with the folder selector, not in:.';
    if (!['from', 'sender', 'to', 'tag', 'has', 'before', 'after'].includes(key))
      return `${key}: is not a supported saved-view operator.`;
    const canonical = key === 'sender' ? 'from' : key;
    if (seen.has(canonical)) return `Use ${canonical}: only once in a saved view.`;
    seen.add(canonical);
    const rawValue = operator[2];
    if (!rawValue || (rawValue.includes('"') && !/^"[^"]+"$/.test(rawValue)))
      return `${key}: needs one nonempty value.`;
    const value = rawValue.startsWith('"') ? rawValue.slice(1, -1).trim() : rawValue;
    if (!value) return `${key}: needs one nonempty value.`;
    if (key === 'has' && !/^attachments?$/i.test(value)) return 'Only has:attachment is supported.';
    if (key === 'before' || key === 'after') {
      const date = new Date(`${value}T00:00:00Z`);
      if (
        !DATE_RE.test(value) ||
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
      )
        return `${key}: needs a real date in YYYY-MM-DD format.`;
    }
    hasCriterion = true;
  }
  if (!hasCriterion) return 'Enter search words or a supported filter.';

  const parsed = parseFederatedSearchQuery(query);
  if (!parsed.text && !Object.keys(parsed.filters).length)
    return 'Enter search words or a supported filter.';
  return null;
}

/** @param {unknown} stored */
export function parseSavedViews(stored) {
  const value = /** @type {Record<string, any>} */ (
    stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  );
  return {
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    views: Array.isArray(value.views) ? value.views : [],
  };
}

/** @param {unknown} body @returns {string | null} */
export function savedViewsError(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return 'Invalid saved-view document.';
  const value = /** @type {Record<string, any>} */ (body);
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    value.revision >= Number.MAX_SAFE_INTEGER
  )
    return 'Invalid saved-view revision.';
  if (!Array.isArray(value.views) || value.views.length > MAX_VIEWS)
    return `Save at most ${MAX_VIEWS} views.`;
  const ids = new Set();
  const names = new Set();
  for (const view of value.views) {
    if (!view || typeof view !== 'object' || Array.isArray(view)) return 'Invalid saved view.';
    if (typeof view.id !== 'string' || !UUID_RE.test(view.id) || ids.has(view.id))
      return 'Each saved view needs a unique ID.';
    if (
      typeof view.name !== 'string' ||
      view.name !== view.name.trim() ||
      !view.name ||
      view.name.length > 60 ||
      [...view.name].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)
    )
      return 'View names must be 1–60 characters without control characters.';
    const normalizedName = view.name.toLocaleLowerCase();
    if (names.has(normalizedName)) return 'Saved-view names must be unique.';
    if (typeof view.folder !== 'string' || !FOLDERS.has(view.folder))
      return 'Choose a supported folder: All mail, Inbox, Sent, Spam, Snoozed, or Done.';
    if (typeof view.query !== 'string' || view.query !== view.query.trim())
      return 'Enter a trimmed saved-view query.';
    const queryError = savedQueryError(view.query);
    if (queryError) return queryError;
    ids.add(view.id);
    names.add(normalizedName);
  }
  return null;
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export async function getSavedViews(sql, userId) {
  const [row] =
    await sql`SELECT prefs -> 'savedSearchViews' AS views FROM users WHERE id = ${userId}`;
  if (!row) return Response.json({ error: 'User not found' }, { status: 404, headers: NO_STORE });
  return Response.json(parseSavedViews(row.views), { headers: NO_STORE });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {unknown} body */
export async function putSavedViews(sql, userId, body) {
  const error = savedViewsError(body);
  if (error) return Response.json({ error }, { status: 400, headers: NO_STORE });
  const value =
    /** @type {{revision: number, views: {id: string, name: string, query: string, folder: string}[]}} */ (
      body
    );
  const next = {
    revision: value.revision + 1,
    views: value.views.map(({ id, name, query, folder }) => ({ id, name, query, folder })),
  };
  const [saved] = await sql`
    UPDATE users
    SET prefs = jsonb_set(coalesce(prefs, '{}'::jsonb), '{savedSearchViews}', ${sql.json(next)}, true)
    WHERE id = ${userId}
      AND coalesce(prefs -> 'savedSearchViews' ->> 'revision', '0') = ${String(value.revision)}
    RETURNING prefs -> 'savedSearchViews' AS views
  `;
  if (saved) return Response.json(parseSavedViews(saved.views), { headers: NO_STORE });
  const [current] =
    await sql`SELECT prefs -> 'savedSearchViews' AS views FROM users WHERE id = ${userId}`;
  if (!current)
    return Response.json({ error: 'User not found' }, { status: 404, headers: NO_STORE });
  return Response.json(
    { error: 'Saved views changed in another session', current: parseSavedViews(current.views) },
    { status: 409, headers: NO_STORE },
  );
}
