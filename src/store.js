/**
 * @param {import('postgres').Sql} sql
 * @param {any} record
 * @param {string} ownerEmail
 * @returns {Promise<{outcome: 'inserted' | 'duplicate', messageUuid: string | null}>}
 */
export async function storeEmail(sql, record, ownerEmail) {
  const messageUuid = crypto.randomUUID();
  const threadUuid = crypto.randomUUID();
  const lookup = await sql`
    SELECT
      users.id AS user_id,
      EXISTS (
        SELECT 1 FROM messages
        WHERE messages.user_id = users.id
          AND messages.message_id = ${record.messageId}
      ) AS is_duplicate,
      (
        SELECT messages.thread_id
        FROM messages
        WHERE messages.user_id = users.id
          AND messages.message_id = ANY(${record.references})
        ORDER BY messages.sent_at DESC
        LIMIT 1
      ) AS thread_id
    FROM users
    WHERE users.email = ${ownerEmail}
    ORDER BY users.created_at
    LIMIT 1
  `;
  const row = lookup[0];
  if (!row) throw new Error('no users row matches OWNER_EMAIL; message not stored');
  if (row.is_duplicate) return { outcome: 'duplicate', messageUuid: null };

  const userId = row.user_id;
  const threadId = row.thread_id ?? threadUuid;
  const sentAt = record.sentAt.toISOString();
  const statements = [];

  if (!row.thread_id) {
    statements.push((sql) => sql`
      INSERT INTO threads (id, user_id, subject, last_message_at)
      VALUES (${threadId}, ${userId}, ${record.subject}, ${sentAt})
    `);
  }

  statements.push((sql) => sql`
    INSERT INTO messages (
      id, thread_id, user_id, from_name, from_address, recipients, subject, snippet,
      body_text, body_html, sent_at, message_id, headers, raw_size, truncated,
      envelope_from, envelope_to
    )
    VALUES (
      ${messageUuid}, ${threadId}, ${userId}, ${record.fromName}, ${record.fromAddress},
      ${JSON.stringify(record.recipients)}::jsonb, ${record.subject}, ${record.snippet},
      ${record.bodyText}, ${record.bodyHtml}, ${sentAt}, ${record.messageId},
      ${JSON.stringify(record.headers)}::jsonb, ${record.rawSize}, ${record.truncated},
      ${record.envelopeFrom}, ${record.envelopeTo}
    )
    ON CONFLICT (user_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
  `);

  for (const attachment of record.attachments) {
    statements.push((sql) => sql`
      INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, blob_url)
      VALUES (
        ${crypto.randomUUID()}, ${messageUuid}, ${attachment.filename},
        ${attachment.mime_type}, ${attachment.size}, ${null}
      )
    `);
  }

  if (row.thread_id) {
    statements.push((sql) => sql`
      UPDATE threads
      SET message_count = message_count + 1,
          last_message_at = GREATEST(last_message_at, ${sentAt}::timestamptz)
      WHERE id = ${threadId}
        AND EXISTS (SELECT 1 FROM messages WHERE id = ${messageUuid})
    `);
  }

  await sql.begin(async (sql) => {
    for (const statement of statements) await statement(sql);
  });
  return { outcome: 'inserted', messageUuid };
}
