import { applyLabelRules } from './rules.js';

// jsonb writes use tx.json(value), never JSON.stringify(value) bound with a
// trailing ::jsonb cast: postgres.js sends an already-stringified parameter
// as jsonb text, which Postgres parses back into a jsonb *string scalar*
// rather than an object - see data-enricher/src/store.js for the same fix.

/**
 * Fast duplicate check before attachment uploads. storeEmail repeats the
 * check and keeps its unique-index guard because another delivery can still
 * win the race after this read.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} messageId
 * @param {string} ownerEmail
 */
export async function emailAlreadyStored(sql, messageId, ownerEmail) {
  const [row] = await sql`
    SELECT users.id,
           EXISTS (
             SELECT 1 FROM messages
             WHERE messages.user_id = users.id
               AND messages.message_id = ${messageId}
           ) AS is_duplicate
    FROM users
    WHERE users.email = ${ownerEmail}
    ORDER BY users.created_at
    LIMIT 1
  `;
  if (!row) throw new Error('no users row matches OWNER_EMAIL; message not stored');
  return Boolean(row.is_duplicate);
}

/**
 * @param {import('postgres').Sql} sql
 * @param {any} record
 * @param {string} ownerEmail
 * @returns {Promise<{outcome: 'inserted' | 'duplicate', messageUuid: string | null}>}
 */
export async function storeEmail(sql, record, ownerEmail) {
  const messageUuid = crypto.randomUUID();
  const threadUuid = crypto.randomUUID();
  const [userRow] = await sql`
    SELECT users.id AS user_id
    FROM users
    WHERE users.email = ${ownerEmail}
    ORDER BY users.created_at
    LIMIT 1
  `;
  if (!userRow) throw new Error('no users row matches OWNER_EMAIL; message not stored');
  const userId = userRow.user_id;
  const sentAt = record.sentAt.toISOString();

  /** @type {boolean} */
  let inserted = false;
  let threadId = threadUuid;

  await sql.begin(async (tx) => {
    // Two inbound emails for the same user can be ingested by concurrent
    // Worker invocations. Without serializing per user, both could read "no
    // thread_id yet" for the same references and each insert its own thread
    // row, splitting one conversation in two. See data-enricher/src/store.js
    // (replaceSingletonSummary) for the same advisory-lock pattern.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;

    const [row] = await tx`
      SELECT
        EXISTS (
          SELECT 1 FROM messages
          WHERE messages.user_id = ${userId}
            AND messages.message_id = ${record.messageId}
        ) AS is_duplicate,
        (
          SELECT messages.thread_id
          FROM messages
          WHERE messages.user_id = ${userId}
            AND messages.message_id = ANY(${record.references})
          ORDER BY messages.sent_at DESC
          LIMIT 1
        ) AS thread_id
    `;
    if (row.is_duplicate) return;

    threadId = row.thread_id ?? threadUuid;
    const isNewThread = !row.thread_id;

    if (isNewThread) {
      await tx`
        INSERT INTO threads (id, user_id, subject, last_message_at, message_count)
        VALUES (${threadId}, ${userId}, ${record.subject}, ${sentAt}, ${1})
      `;
    }

    // RETURNING distinguishes a real insert from a concurrent unique-index
    // no-op (lookup raced another MTA retry). Without this, DO NOTHING left us
    // reporting "inserted" for a UUID that was never written.
    const insertedRows = await tx`
      INSERT INTO messages (
        id, thread_id, user_id, from_name, from_address, recipients, subject, snippet,
        body_text, body_html, sent_at, message_id, headers, raw_size, truncated,
        envelope_from, envelope_to
      )
      VALUES (
        ${messageUuid}, ${threadId}, ${userId}, ${record.fromName}, ${record.fromAddress},
        ${tx.json(record.recipients)}, ${record.subject}, ${record.snippet},
        ${record.bodyText}, ${record.bodyHtml}, ${sentAt}, ${record.messageId},
        ${tx.json(record.headers)}, ${record.rawSize}, ${record.truncated},
        ${record.envelopeFrom}, ${record.envelopeTo}
      )
      ON CONFLICT (user_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
      RETURNING id
    `;

    if (insertedRows.length === 0) {
      // Concurrent duplicate: drop the empty thread we just created (if any).
      if (isNewThread) {
        await tx`
          DELETE FROM threads t
          WHERE t.id = ${threadId}
            AND NOT EXISTS (
              SELECT 1 FROM messages m WHERE m.thread_id = t.id
            )
        `;
      }
      return;
    }

    inserted = true;

    await tx`
      INSERT INTO message_ai (message_id, status, provider, prompt_version)
      VALUES (${messageUuid}, 'pending', 'openai', 'email-enrichment-v1')
      ON CONFLICT (message_id) DO NOTHING
    `;

    // Deterministic, so it runs synchronously in the storage transaction
    // rather than the best-effort waitUntil path AI enrichment takes.
    await applyLabelRules(tx, userId, messageUuid, record);

    if (record.attachments.length > 0) {
      const attachmentRows = record.attachments.map((attachment) => ({
        id: crypto.randomUUID(),
        message_id: messageUuid,
        filename: attachment.filename,
        content_type: attachment.mime_type,
        size_bytes: attachment.size,
        blob_url: attachment.blob_url ?? null,
      }));
      await tx`
        INSERT INTO attachments (id, message_id, filename, content_type, size_bytes, blob_url)
        SELECT row.id::uuid, row.message_id::uuid, row.filename, row.content_type,
               row.size_bytes, row.blob_url
        FROM jsonb_to_recordset(${tx.json(attachmentRows)}) AS row(
          id text, message_id text, filename text, content_type text,
          size_bytes bigint, blob_url text
        )
      `;
    }

    if (!isNewThread) {
      await tx`
        UPDATE threads
        SET message_count = message_count + 1,
            last_message_at = GREATEST(last_message_at, ${sentAt}::timestamptz)
        WHERE id = ${threadId}
      `;
    }
  });

  if (!inserted) return { outcome: 'duplicate', messageUuid: null };
  return { outcome: 'inserted', messageUuid };
}
