// The attachment library: every file the mailbox received or sent, newest
// first, for the Email attachments folder in Cookie-Web's Documents area.
//
// Nothing is stored for it. Received and sent files are both rows of
// `attachments` (a sent message keeps its files there too), so one read over
// that table and its messages answers the whole list.

import { isTransientDbError } from '../../../shared/transient-db.js';

export const ATTACHMENT_PAGE_SIZE = 100;

// "<sent_at>|<attachment id>" of the last row of the previous page, the same
// shape GET /emails uses.
const CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

const DIRECTIONS = new Set(['received', 'sent']);

/**
 * One page of the mailbox's attachments, newest message first. Trash, spam
 * and mail from senders that are held or blocked are left out, as they are
 * from the rest of the app's lists.
 *
 * `embedded` marks a picture that belongs to the body of its email (a logo, a
 * signature, a screenshot placed in the text) rather than a file someone
 * attached. Ingest does not record which parts were inline, so it is read
 * from the mail: an image on a message whose HTML shows a `cid:` picture. The
 * body is only looked at for images. The pattern is written without
 * backslashes so it reads the same in JavaScript and in SQL.
 *
 * The cursor's timestamp is bound as text: postgres.js would otherwise send it
 * as a Date and drop the microseconds the keyset comparison needs.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {{
 *   direction: 'received' | 'sent' | null,
 *   includeEmbedded: boolean,
 *   cursor: {sentAt: string, id: string} | null,
 * }} options
 */
export function fetchAttachmentPage(sql, userId, { direction, includeEmbedded, cursor }) {
  return sql`
    SELECT a.id, a.filename, a.content_type, a.size_bytes,
           (a.blob_url IS NOT NULL) AS downloadable,
           flags.embedded,
           m.id AS message_id, m.subject, m.is_sent, m.from_name, m.from_address,
           m.is_unread, m.is_starred, m.is_archived,
           CASE WHEN m.is_sent
                THEN CASE WHEN jsonb_typeof(m.recipients) = 'string'
                          THEN (m.recipients #>> '{}')::jsonb
                          ELSE m.recipients END -> 'to'
           END AS sent_to,
           to_char(m.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS sent_at,
           to_char(m.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sent_cursor
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    CROSS JOIN LATERAL (
      SELECT CASE WHEN a.content_type ILIKE 'image/%'
                  THEN COALESCE(
                    m.body_html ~* '(src[[:space:]]*=[[:space:]]*|url[(])[[:space:]]*["'']?cid:',
                    false
                  )
                  ELSE false END AS embedded
    ) flags
    WHERE m.user_id = ${userId}
      AND NOT m.is_deleted
      AND m.screening_status = 'allowed'
      AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
      AND (${direction}::text IS NULL OR m.is_sent = (${direction}::text = 'sent'))
      AND (${includeEmbedded}::boolean OR NOT flags.embedded)
      AND (
        ${cursor?.sentAt ?? null}::text IS NULL
        OR (m.sent_at, a.id)
           < (${cursor?.sentAt ?? null}::text::timestamptz, ${cursor?.id ?? null}::uuid)
      )
    ORDER BY m.sent_at DESC, a.id DESC
    LIMIT ${ATTACHMENT_PAGE_SIZE + 1}
  `;
}

/**
 * Who the file came from, or the first person it was sent to. Recipients are
 * stored as `{address, name}` objects; anything else is treated as absent.
 *
 * @param {any} row
 * @returns {{name: string | null, address: string, others: number} | null}
 */
function correspondent(row) {
  if (!row.is_sent) {
    const address = String(row.from_address ?? '').trim();
    return address ? { name: row.from_name || null, address, others: 0 } : null;
  }
  const recipients = (Array.isArray(row.sent_to) ? row.sent_to : [])
    .map((entry) => ({
      name: entry?.name ? String(entry.name) : null,
      address: String(entry?.address ?? '').trim(),
    }))
    .filter((entry) => entry.address);
  if (!recipients.length) return null;
  return { ...recipients[0], others: recipients.length - 1 };
}

/**
 * GET /messages/attachments — the attachment library, newest first, 100 to a
 * page.
 *
 *   direction=received|sent  one side only; absent lists both
 *   embedded=1               also list pictures that belong to an email's body
 *   before=<nextCursor>      the next page
 *
 * Responds {attachments, nextCursor}; nextCursor is null on the last page.
 * `id` is what GET /messages/attachment?id= downloads, and `downloadable` is
 * false for a file whose bytes were never stored. The private Blob URL never
 * leaves the server. `unread`, `starred` and `archived` describe the email,
 * so the client can open it from the list in the state it is in.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 */
export async function getAttachmentLibrary(sql, userId, url) {
  const requestedDirection = url.searchParams.get('direction');
  if (requestedDirection && !DIRECTIONS.has(requestedDirection)) {
    return Response.json({ error: 'Invalid direction' }, { status: 400 });
  }
  const direction = /** @type {'received' | 'sent' | null} */ (requestedDirection || null);

  /** @type {{sentAt: string, id: string} | null} */
  let cursor = null;
  const before = url.searchParams.get('before');
  if (before) {
    const match = CURSOR_RE.exec(before);
    if (!match || Number.isNaN(Date.parse(match[1]))) {
      return Response.json({ error: 'Invalid before cursor' }, { status: 400 });
    }
    cursor = { sentAt: match[1], id: match[2] };
  }

  try {
    const rows = await fetchAttachmentPage(sql, userId, {
      direction,
      includeEmbedded: url.searchParams.get('embedded') === '1',
      cursor,
    });
    const hasMore = rows.length > ATTACHMENT_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, ATTACHMENT_PAGE_SIZE) : rows;
    const last = page[page.length - 1];
    return Response.json(
      {
        attachments: page.map((row) => ({
          id: row.id,
          filename: row.filename || null,
          contentType: row.content_type || null,
          sizeBytes: (row.size_bytes ?? null) === null ? null : Number(row.size_bytes),
          downloadable: Boolean(row.downloadable),
          embedded: Boolean(row.embedded),
          direction: row.is_sent ? 'sent' : 'received',
          messageId: row.message_id,
          subject: row.subject || null,
          correspondent: correspondent(row),
          date: row.sent_at,
          unread: Boolean(row.is_unread),
          starred: Boolean(row.is_starred),
          archived: Boolean(row.is_archived),
        })),
        nextCursor: hasMore ? `${last.sent_cursor}|${last.id}` : null,
      },
      // Keyed by URL, not by account: see getContacts.
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    // A dropped connection is the worker's to retry, not this handler's to
    // report.
    if (isTransientDbError(error)) throw error;
    console.log(
      JSON.stringify({
        event: 'attachment_library_failed',
        message: /** @type {Error} */ (error).message,
      }),
    );
    return Response.json({ error: 'Failed to load attachments' }, { status: 500 });
  }
}
