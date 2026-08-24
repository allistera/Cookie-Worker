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
    // no-store: the browser HTTP cache is keyed by URL, not by account, so a
    // cached response could leak one account's correspondents to the next
    // account signed in on the same profile. The inbox store already keeps
    // its own in-memory copy per session (contactsLoaded), which is dropped
    // with the store on account change — that's the only cache we want.
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
