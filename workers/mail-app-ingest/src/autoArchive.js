import { autoArchiveSince } from '../../../shared/autoArchive.js';

/**
 * Recheck settings under a lock: disabling a category during classification
 * must win. Keep messages the user has read, starred or scheduled.
 * @param {import('postgres').TransactionSql} tx
 * @param {string} userId
 * @param {string} messageId
 * @param {string} category
 */
export async function applyAutoArchive(tx, userId, messageId, category) {
  const [user] =
    await tx`SELECT prefs -> 'autoArchive' AS settings FROM users WHERE id = ${userId} FOR SHARE`;
  const since = autoArchiveSince(user?.settings, category);
  if (!since) return;
  const [archived] = await tx`
    UPDATE messages SET is_archived = true, is_unread = false
    WHERE id = ${messageId} AND user_id = ${userId} AND created_at >= ${since}::timestamptz
      AND is_unread AND NOT is_starred AND NOT is_sent AND NOT is_deleted AND NOT is_archived
      AND scheduled_for IS NULL
    RETURNING id
  `;
  if (archived) {
    await tx`DELETE FROM browser_notification_events WHERE message_id = ${messageId} AND user_id = ${userId}`;
  }
}
