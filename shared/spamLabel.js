/**
 * The system "Spam" label, created for the message's owner on first use. Both
 * spam writers call this: the AI classifier (mail-app-ingest) and the user's own
 * report (cookie-web-messages). Each then attaches the label with its own
 * provenance, because an AI attachment carries a score and model while a user
 * report is manual. This function only creates or reuses the label row.
 *
 * Returns the label id, or null when no row was returned: the message does not
 * exist, or the owner already has a non-system label with this name, which the
 * ON CONFLICT guard leaves untouched.
 *
 * @param {import('postgres').TransactionSql} tx
 * @param {string} messageId
 * @returns {Promise<string | null>}
 */
export async function ensureSpamLabel(tx, messageId) {
  const [spamLabel] = await tx`
    INSERT INTO labels (user_id, name, color, kind, description, auto_apply)
    SELECT m.user_id, 'Spam', '#64748b', 'system', 'High-confidence spam detected by Cookie AI', false
    FROM messages m WHERE m.id = ${messageId}
    ON CONFLICT (user_id, name) DO UPDATE
    SET auto_apply = false
    WHERE labels.kind = 'system'
    RETURNING id
  `;
  return spamLabel ? String(spamLabel.id) : null;
}
