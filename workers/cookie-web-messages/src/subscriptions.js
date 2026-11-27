// Subscriptions: the senders whose mail carries a List-Unsubscribe header
// (RFC 2369), one row per sender address, and the record of the senders the
// person has unsubscribed from.
//
// Detection reads only headers the mail already has; nothing is classified by
// AI. A sender is listed when the newest of their list mail offers a method
// POST /messages `action: unsubscribe` can act on, so every row's button works.

import { isSafeUnsubscribeUrl, parseListUnsubscribe } from './unsubscribe.js';

// The list is newest sender first, so the cut drops the senders that have been
// quiet the longest.
const MAX_SUBSCRIPTIONS = 1000;

/**
 * The newest list message of each sender, with how many list messages the
 * sender has in the mailbox. Trash, sent mail, spam and mail from senders that
 * are held or blocked are left out.
 *
 * The header test is spelled exactly as the predicate of the partial index
 * messages_list_unsubscribe_idx (migration 0115), so that only list
 * mail is visited and only each sender's newest message has its headers read.
 * Without the index the query returns the same rows, more slowly.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
function fetchSubscriptionSenders(sql, userId) {
  return sql`
    WITH list_mail AS MATERIALIZED (
      SELECT m.id, m.from_name, lower(btrim(m.from_address)) AS address, m.sent_at
      FROM messages m
      LEFT JOIN message_ai ai ON ai.message_id = m.id
      WHERE m.user_id = ${userId}
        AND NOT m.is_sent
        AND jsonb_typeof(m.headers) = 'array'
        AND jsonb_path_exists(m.headers, '$[*] ? (@.key like_regex "^list-unsubscribe$" flag "i")')
        AND NOT m.is_deleted
        AND m.screening_status = 'allowed'
        AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
    ),
    newest AS (
      SELECT DISTINCT ON (address) id, from_name, address, sent_at,
             (count(*) OVER (PARTITION BY address))::int AS message_count
      FROM list_mail
      ORDER BY address, sent_at DESC, id DESC
    )
    SELECT n.id, n.from_name, n.address, n.message_count,
           to_char(n.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS sent_at,
           (
             SELECT jsonb_agg(header)
             FROM jsonb_array_elements(m.headers) header
             WHERE lower(header ->> 'key') IN ('list-unsubscribe', 'list-unsubscribe-post')
           ) AS list_headers
    FROM newest n
    JOIN messages m ON m.id = n.id
    ORDER BY n.sent_at DESC, n.id DESC
    LIMIT ${MAX_SUBSCRIPTIONS}
  `;
}

/**
 * When the person unsubscribed from each sender, keyed by sender address. An
 * empty map until migration 0115 has created the table, so this
 * Worker can be deployed before or after it.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @returns {Promise<Map<string, string>>}
 */
async function fetchUnsubscribedSenders(sql, userId) {
  try {
    const rows = await sql`
      SELECT address,
             to_char(unsubscribed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               AS unsubscribed_at
      FROM sender_unsubscribes
      WHERE user_id = ${userId}
    `;
    return new Map(rows.map((row) => [String(row.address), String(row.unsubscribed_at)]));
  } catch (error) {
    // 42P01 undefined_table: the migration has not been applied yet.
    if (/** @type {{code?: string}} */ (error).code === '42P01') return new Map();
    throw error;
  }
}

/**
 * GET /messages/subscriptions — the senders the mailbox is subscribed to,
 * newest mail first. `messageId` is the sender's newest list message, the one
 * to name in POST /messages `action: unsubscribe`. `unsubscribedAt` is null
 * until an unsubscribe from that sender has been confirmed.
 *
 * The sender-controlled headers never leave the server.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function getSubscriptions(sql, userId) {
  const rows = await fetchSubscriptionSenders(sql, userId);
  const unsubscribed = await fetchUnsubscribedSenders(sql, userId);
  const subscriptions = [];
  for (const row of rows) {
    const parsed = parseListUnsubscribe(row.list_headers);
    // The same test POST /messages applies before it reports 422.
    if (!parsed || !(parsed.mailto || isSafeUnsubscribeUrl(parsed.url))) continue;
    subscriptions.push({
      address: row.address,
      name: row.from_name || null,
      messageId: row.id,
      messageCount: row.message_count,
      lastReceivedAt: row.sent_at,
      unsubscribedAt: unsubscribed.get(row.address) ?? null,
    });
  }
  return Response.json(
    { subscriptions },
    // Keyed by URL, not by account: see getContacts.
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/**
 * Remembers a confirmed unsubscribe from a message's sender, so Subscriptions
 * can show it as done. Best effort: the unsubscribe itself has already
 * happened, so a failure here (the table is missing until migration 0115)
 * is logged and must not turn the response into an error.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} address The sender, lower-cased and trimmed.
 * @param {'one-click' | 'mailto' | 'ai'} method
 */
export async function recordUnsubscribe(sql, userId, address, method) {
  if (!address) return;
  try {
    await sql`
      INSERT INTO sender_unsubscribes (user_id, address, method)
      VALUES (${userId}, ${address}, ${method})
      ON CONFLICT (user_id, address) DO UPDATE
      SET method = EXCLUDED.method, unsubscribed_at = now()
    `;
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'unsubscribe_record_failed',
        message: /** @type {Error} */ (error).message,
      }),
    );
  }
}
