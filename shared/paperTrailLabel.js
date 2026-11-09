// Cookie-Web's Paper Trail sidebar item opens the label list of this name
// (src/lib/paperTrail.js there), so the two must stay the same.
export const PAPER_TRAIL_LABEL = 'Paper Trail';

/**
 * The system "Paper Trail" label, created for the message's owner on first
 * use. The ingest classifier (mail-app-ingest) attaches it to receipts,
 * confirmations and other transactional mail, which is all that puts a
 * message in Cookie-Web's Paper Trail list; the message stays in the inbox.
 *
 * Returns the label id, or null when no row was returned: the message does not
 * exist, or the owner already has a non-system label with this name, which the
 * ON CONFLICT guard leaves untouched.
 *
 * @param {import('postgres').TransactionSql} tx
 * @param {string} messageId
 * @returns {Promise<string | null>}
 */
export async function ensurePaperTrailLabel(tx, messageId) {
  const [label] = await tx`
    INSERT INTO labels (user_id, name, color, kind, description, auto_apply)
    SELECT m.user_id, ${PAPER_TRAIL_LABEL}, '#0f766e', 'system',
           'Receipts, confirmations and transactional mail detected by Cookie AI', false
    FROM messages m WHERE m.id = ${messageId}
    ON CONFLICT (user_id, name) DO UPDATE
    SET auto_apply = false
    WHERE labels.kind = 'system'
    RETURNING id
  `;
  return label ? String(label.id) : null;
}
