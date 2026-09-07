// Ported from Cookie-Web's api/emails.js. Behaviorally identical (same
// queries, same validation, same response shapes/status codes) — only the
// (req, res) mutation style becomes returning a Response, and the
// ?resource=state multiplexing becomes its own clean /emails/state route.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_LABEL_NAME = 100;
const CURSOR_RE = /^(.+)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const FOLDERS = new Set(['inbox', 'sent', 'spam', 'snoozed', 'done', 'starred', 'label']);

// Folder predicates are inlined (not `${folder} = 'inbox'`) so Postgres can
// use the 0035 partial indexes. Parameterized OR-across-folders cannot.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} folder
 * @param {string} [labelName]
 */
export function folderPredicate(sql, folder, labelName) {
  if (folder === 'done') return sql`m.is_archived`;
  if (folder === 'sent') return sql`NOT m.is_archived AND m.is_sent`;
  if (folder === 'spam') {
    return sql`NOT m.is_archived AND NOT m.is_sent AND ai.spam_verdict = 'spam'`;
  }
  if (folder === 'snoozed') {
    return sql`NOT m.is_archived AND NOT m.is_sent
      AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
      AND m.scheduled_for > now()`;
  }
  if (folder === 'starred') return sql`m.is_starred`;
  if (folder === 'label') {
    return sql`EXISTS (
      SELECT 1
      FROM message_labels tagged
      JOIN labels tagged_l ON tagged_l.id = tagged.label_id
      WHERE tagged.message_id = m.id
        AND tagged_l.user_id = m.user_id
        AND tagged_l.name = ${labelName}
    )`;
  }
  return sql`NOT m.is_archived AND (
    (
      NOT m.is_sent
      AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
      AND (m.scheduled_for IS NULL OR m.scheduled_for <= now())
    )
    OR (
      m.is_sent
      AND m.follow_up_at <= now()
      AND NOT EXISTS (
        SELECT 1
        FROM messages reply
        WHERE reply.user_id = m.user_id
          AND reply.thread_id = m.thread_id
          AND NOT reply.is_sent
          AND NOT reply.is_deleted
          AND reply.sent_at > m.sent_at
      )
    )
  )`;
}

function sortExpression(sql, folder) {
  return folder === 'inbox'
    ? sql`CASE WHEN m.is_sent THEN m.follow_up_at ELSE m.sent_at END`
    : sql`m.sent_at`;
}

// Keyset pagination on (sort_at, id) DESC. Inbox reminders use follow_up_at;
// other rows use sent_at. The cursor is "<sort_at>|<id>" of the previous page.
// Fetch one extra row to learn whether another page exists.
// folder selects inbox, sent/outbox, high-confidence AI spam, snoozed, or
// archived (Done) mail. Recipients let the client render "To: <address>" for
// outbound rows.
// Message bodies are deliberately excluded: list rows render the stored snippet,
// while the authoritative body is fetched only when the reader opens.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {number} limit
 * @param {{sentAt: string, id: string} | null} cursor
 * @param {string} folder
 * @param {string} [labelName]
 */
export function fetchEmails(sql, userId, limit, cursor, folder, labelName = '') {
  const sortAt = sortExpression(sql, folder);
  return sql`
    SELECT m.id, m.from_name, m.from_address,
           CASE WHEN jsonb_typeof(m.recipients) = 'string'
                THEN (m.recipients #>> '{}')::jsonb
                ELSE m.recipients END AS recipients,
           m.subject, m.snippet, ${sortAt} AS sort_at,
           m.sent_at, m.is_unread, m.is_starred,
           m.is_sent, m.is_archived, m.scheduled_for, m.follow_up_at, ai.spam_score, ai.spam_verdict,
           ai.priority,
           BOOL_OR(
             NULLIF(BTRIM(t.ai_summary), '') IS NOT NULL
             AND t.ai_summary_message_id = (
               SELECT newest.id
               FROM messages newest
               WHERE newest.thread_id = t.id AND newest.user_id = t.user_id
                 AND NOT newest.is_deleted
               ORDER BY newest.sent_at DESC, newest.id DESC
               LIMIT 1
             )
           ) AS has_ai_summary,
           (m.body_html IS NOT NULL) AS has_html,
           EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
           COALESCE(
             json_agg(json_build_object('name', l.name, 'color', l.color, 'kind', l.kind)
                      ORDER BY l.name)
               FILTER (WHERE l.id IS NOT NULL),
             '[]'
           ) AS labels
    FROM messages m
    JOIN threads t ON t.id = m.thread_id AND t.user_id = m.user_id
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    LEFT JOIN message_labels ml ON ml.message_id = m.id
    LEFT JOIN labels l ON l.id = ml.label_id
    WHERE m.user_id = ${userId}
      AND NOT m.is_deleted
      AND (${folderPredicate(sql, folder, labelName)})
      ${cursor ? sql`AND (${sortAt}, m.id) < (${cursor.sentAt}::timestamptz, ${cursor.id}::uuid)` : sql``}
    GROUP BY m.id, ai.spam_score, ai.spam_verdict, ai.priority
    ORDER BY ${sortAt} DESC, m.id DESC
    LIMIT ${limit + 1}
  `;
}

// A bare aggregate (no GROUP BY) always returns exactly one row, even when
// zero messages match, so this no longer needs to anchor on users the way it
// did when it was also the source of the caller's userId (the caller already
// has it from verifyAccessToken). is_unread stays in the WHERE, matching the
// partial index messages_unread_idx (migration 0001).
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export function fetchUnreadCount(sql, userId) {
  return sql`
    SELECT count(m.id) FILTER (
             WHERE COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
           )::int AS unread
    FROM messages m
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    WHERE m.user_id = ${userId} AND m.is_unread
      AND NOT m.is_archived AND NOT m.is_sent AND NOT m.is_deleted
      AND (m.scheduled_for IS NULL OR m.scheduled_for <= now())
  `;
}

// How many messages the Spam folder holds. The sidebar only lists Spam
// while this is non-zero, so it travels with the unread count on every
// bootstrap and first-page payload. Same predicate as folderPredicate('spam')
// (plus the list's NOT is_deleted) so the count and the folder always agree;
// the join keeps it on the 0010 partial index message_ai_spam_idx.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export function fetchSpamCount(sql, userId) {
  return sql`
    SELECT count(*)::int AS spam
    FROM messages m
    JOIN message_ai ai ON ai.message_id = m.id
    WHERE m.user_id = ${userId}
      AND ai.spam_verdict = 'spam'
      AND NOT m.is_deleted AND NOT m.is_archived AND NOT m.is_sent
  `;
}

// How many messages the Snoozed folder holds — the sidebar lists Snoozed
// only while this is non-zero, so it travels with the spam count. Same
// predicate as folderPredicate('snoozed') plus the list's NOT is_deleted.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export function fetchSnoozedCount(sql, userId) {
  return sql`
    SELECT count(m.id)::int AS snoozed
    FROM messages m
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    WHERE m.user_id = ${userId}
      AND NOT m.is_deleted AND NOT m.is_archived AND NOT m.is_sent
      AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
      AND m.scheduled_for > now()
  `;
}

/**
 * GET /emails/state — lightweight app bootstrap for routes that need the
 * unread badge and Realtime channel identity but do not render the mailbox
 * list. Previously reached as /api/emails?resource=state.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function handleState(sql, userId) {
  try {
    const [[userRow], [spamRow], [snoozedRow]] = await Promise.all([
      fetchUnreadCount(sql, userId),
      fetchSpamCount(sql, userId),
      fetchSnoozedCount(sql, userId),
    ]);
    return Response.json({
      unreadCount: userRow?.unread ?? 0,
      spamCount: spamRow?.spam ?? 0,
      snoozedCount: snoozedRow?.snoozed ?? 0,
      userId,
    });
  } catch (err) {
    console.error('GET /emails/state failed:', err);
    return Response.json({ error: 'Failed to load inbox state' }, { status: 500 });
  }
}

/**
 * GET /emails?limit=50&before=<sent_at>|<id>&folder=inbox|sent|spam|snoozed|done|starred|label
 * returns the authenticated user's selected folder (inbox by default), newest
 * first. Responds {emails, nextCursor, readReceiptsAvailable, unreadCount,
 * spamCount, snoozedCount, userId}; nextCursor is null on the last page.
 * unreadCount always covers the inbox (sent mail is never unread), and
 * spamCount/snoozedCount the Spam and Snoozed folders, whichever folder was
 * listed — the sidebar shows those two only while they hold something. userId lets the client subscribe to its
 * Realtime inbox-ping channel.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 */
export async function handleList(sql, userId, url) {
  const requestedFolder = url.searchParams.get('folder') || 'inbox';
  const folder = FOLDERS.has(requestedFolder) ? requestedFolder : null;
  if (!folder) {
    return Response.json({ error: 'Invalid folder' }, { status: 400 });
  }
  const labelName = String(url.searchParams.get('label') || '')
    .trim()
    .slice(0, MAX_LABEL_NAME);
  if (folder === 'label' && !labelName) {
    return Response.json({ error: 'label is required' }, { status: 400 });
  }
  const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

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
    // The unread and spam counts only matter on a list's first page; the
    // client ignores them on cursor pages, so skip the aggregates there.
    const [rows, [userRow], [spamRow], [snoozedRow]] = await Promise.all([
      fetchEmails(sql, userId, limit, cursor, folder, labelName),
      cursor ? [] : fetchUnreadCount(sql, userId),
      cursor ? [] : fetchSpamCount(sql, userId),
      cursor ? [] : fetchSnoozedCount(sql, userId),
    ]);
    const hasMore = rows.length > limit;
    const emails = hasMore ? rows.slice(0, limit) : rows;
    const last = emails[emails.length - 1];
    const publicEmails = emails.map((row) => {
      const email = { ...row };
      delete email.sort_at;
      return email;
    });
    /** @type {Record<string, unknown>} */
    const payload = {
      emails: publicEmails,
      // toISOString keeps millisecond precision; Date's default toString
      // truncates to seconds, which can skip same-second rows on page breaks.
      nextCursor: hasMore ? `${last.sort_at.toISOString()}|${last.id}` : null,
      readReceiptsAvailable: folder === 'sent',
    };
    if (!cursor) {
      payload.unreadCount = userRow?.unread ?? 0;
      payload.spamCount = spamRow?.spam ?? 0;
      payload.snoozedCount = snoozedRow?.snoozed ?? 0;
      payload.userId = userId;
    }
    return Response.json(payload);
  } catch (err) {
    console.error('GET /emails failed:', err);
    return Response.json({ error: 'Failed to load emails' }, { status: 500 });
  }
}
