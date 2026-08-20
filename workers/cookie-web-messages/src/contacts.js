// Ported from Cookie-Web's api/_lib/contacts.js.

// Autocomplete stays useful well below this; the bound exists so a
// pathological mailbox (mailing-list traffic, scraped inboxes) can't turn
// the response into megabytes. The view has no usage counts to rank by, so
// the cut is alphabetical like the display order.
const MAX_CONTACTS = 2000;

/**
 * The authenticated user's contacts — addresses that appear in their
 * mailbox (received senders or sent recipients) — from the contacts view,
 * ordered for display.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export function fetchContacts(sql, userId) {
  return sql`
    SELECT c.address, c.name
    FROM contacts c
    WHERE c.user_id = ${userId}
    ORDER BY c.name NULLS LAST, c.address
    LIMIT ${MAX_CONTACTS}
  `;
}

/**
 * GET /messages/contacts — compose auto-suggest contacts.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function getContacts(sql, userId) {
  const rows = await fetchContacts(sql, userId);
  return Response.json(
    { contacts: rows.map((/** @type {any} */ row) => ({ address: row.address, name: row.name })) },
    // The contacts view aggregates the whole mailbox per read (jsonb-unnesting
    // every sent message), and autocomplete tolerates staleness — let the
    // browser reuse the response for a few minutes. private: per-user data,
    // must never land in a shared cache.
    { headers: { 'Cache-Control': 'private, max-age=300' } },
  );
}
