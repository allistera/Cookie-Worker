import { addDocuments, meiliAvailable } from '../../../shared/meili.js';
import { MESSAGES_INDEX } from '../../../shared/meili/messages.js';

/**
 * Best-effort sync of one message to Meilisearch. Reads the authoritative row
 * from Postgres (including labels and, via a LEFT JOIN message_ai, the spam
 * verdict MESSAGES_INDEX.toDocument needs for is_spam) and pushes a
 * document. Failures are logged and ignored so that message
 * delivery/forwarding is never blocked by search.
 *
 * @param {import('postgres').Sql} sql
 * @param {any} env
 * @param {string} messageUuid
 */
export async function syncMessageToMeili(sql, env, messageUuid) {
  if (!meiliAvailable(env)) return;

  try {
    const [row] = await sql`
    SELECT
      m.id,
      m.user_id,
      m.from_name,
      m.from_address,
      m.recipients,
      m.subject,
      m.body_text,
      m.sent_at,
      m.scheduled_for,
      m.is_unread,
      m.is_starred,
      m.is_archived,
      m.is_sent,
      m.is_deleted,
      ai.spam_verdict,
      EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
      COALESCE(
        json_agg(json_build_object('name', l.name) ORDER BY l.name)
          FILTER (WHERE l.id IS NOT NULL),
        '[]'
      ) AS labels
    FROM messages m
    LEFT JOIN message_labels ml ON ml.message_id = m.id
    LEFT JOIN labels l ON l.id = ml.label_id
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    WHERE m.id = ${messageUuid}
    GROUP BY m.id, ai.spam_verdict
  `;

    if (!row) {
      console.log(JSON.stringify({ event: 'meili_sync_missing', message_id: messageUuid }));
      return;
    }

    const result = await addDocuments(env, MESSAGES_INDEX, [row]);
    await sql`UPDATE messages SET search_indexed_at = now() WHERE id = ${messageUuid}`;
    console.log(
      JSON.stringify({
        event: 'meili_synced',
        message_id: messageUuid,
        task_uid: result.taskUid,
      }),
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        event: 'meili_sync_failed',
        message_id: messageUuid,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
