// Ported from Cookie-Web's api/_lib/dailyNoteSeed.js — pure SQL/validation,
// no Node APIs. (req, res) handling becomes returning a Response.

import { normalizeBlocks } from './documents.js';

// The default content new daily notes are seeded with (see openTodayNote in
// src/stores/documents.js), customizable in Settings > Documents > Time
// Management. Lives in users.prefs like interests.js's topics: a small
// per-user preference with no need for its own table. An empty array is the
// valid "not customized, use the built-in default" state, not an error.
/** @param {import('postgres').Sql} sql @param {string} userId */
export function fetchDailyNoteSeed(sql, userId) {
  return sql`
    SELECT coalesce(u.prefs -> 'dailyNoteSeed', '[]'::jsonb) AS blocks
    FROM users u
    WHERE u.id = ${userId}
  `;
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {any[]} blocks */
export function saveDailyNoteSeed(sql, userId, blocks) {
  // sql.json (not a manually JSON.stringify'd string cast with ::jsonb) is
  // required here: postgres.js sends a pre-stringified string parameter as
  // jsonb text that Postgres parses back into a jsonb *string scalar*, not an
  // object, which turns the || below into an array-append instead of a
  // key merge and silently drops every previous save.
  return sql`
    UPDATE users
    SET prefs = coalesce(prefs, '{}'::jsonb) || ${sql.json({ dailyNoteSeed: blocks })}
    WHERE id = ${userId}
    RETURNING coalesce(prefs -> 'dailyNoteSeed', '[]'::jsonb) AS blocks
  `;
}

// GET /tasks/daily-note-seed
/** @param {import('postgres').Sql} sql @param {string} userId */
export async function getDailyNoteSeed(sql, userId) {
  const [row] = await fetchDailyNoteSeed(sql, userId);
  return Response.json({ blocks: row?.blocks ?? [] });
}

// PUT /tasks/daily-note-seed
/** @param {import('postgres').Sql} sql @param {string} userId @param {any} body */
export async function putDailyNoteSeed(sql, userId, body) {
  const blocks = normalizeBlocks(body?.blocks ?? []);
  if (!blocks) {
    return Response.json({ error: 'blocks must be an array of block objects' }, { status: 400 });
  }

  const [row] = await saveDailyNoteSeed(sql, userId, blocks);
  if (!row) return Response.json({ error: 'User not found' }, { status: 404 });
  return Response.json({ blocks: row.blocks });
}
