import { createTimings } from '../../../shared/performance.js';
// Ported from Cookie-Web's api/emails.js. Behaviorally identical (same
// queries, same validation, same response shapes/status codes) — only the
// (req, res) mutation style becomes returning a Response, and the
// ?resource=state multiplexing becomes its own clean /emails/state route.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_LABEL_NAME = 100;
const CURSOR_RE = /^(.+)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const FOLDERS = new Set([
  'inbox',
  'sent',
  'spam',
  'snoozed',
  'done',
  'starred',
  'label',
  'screening',
  'blocked',
]);

// Folder predicates are inlined (not `${folder} = 'inbox'`) so Postgres can
// use the 0035 partial indexes. Parameterized OR-across-folders cannot.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} folder
 * @param {string} [labelName]
 */
export function folderPredicate(sql, folder, labelName) {
  if (folder === 'screening') return sql`NOT m.is_sent AND m.screening_status = 'held'`;
  if (folder === 'blocked') return sql`NOT m.is_sent AND m.screening_status = 'blocked'`;
  if (folder === 'done') return sql`m.is_archived`;
  if (folder === 'sent') return sql`NOT m.is_archived AND m.is_sent`;
  if (folder === 'spam') {
    return sql`NOT m.is_archived AND NOT m.is_sent AND ai.spam_verdict = 'spam'`;
  }
  if (folder === 'snoozed') {
    return sql`NOT m.is_archived AND NOT m.is_sent
    AND ai.status = 'completed'
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
  return sql`(${receivedInboxPredicate(sql)}) OR (${followUpPredicate(sql)})`;
}

function receivedInboxPredicate(sql) {
  return sql`NOT m.is_archived AND NOT m.is_sent
    AND ai.status = 'completed'
    AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
    AND (m.scheduled_for IS NULL OR m.scheduled_for <= now())`;
}

function followUpPredicate(sql) {
  return sql`NOT m.is_archived AND m.is_sent AND m.follow_up_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM messages reply
      WHERE reply.user_id = m.user_id AND reply.thread_id = m.thread_id
        AND NOT reply.is_sent AND NOT reply.is_deleted AND reply.sent_at > m.sent_at
        AND reply.screening_status = 'allowed'
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
  // Limit each disjoint inbox branch in its native index order, before
  // aggregating labels and looking up summary metadata. Each branch needs
  // at most one page to produce the globally newest page.
  const candidatePage = (order, predicate) => sql`
    SELECT m.id, ${order} AS sort_at
    FROM messages m
    JOIN threads t ON t.id = m.thread_id AND t.user_id = m.user_id
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    WHERE m.user_id = ${userId} AND NOT m.is_deleted AND (${predicate})
      ${['screening', 'blocked'].includes(folder) ? sql`` : sql`AND m.screening_status = 'allowed'`}
      ${cursor ? sql`AND (${order}, m.id) < (${cursor.sentAt}::text::timestamptz, ${cursor.id}::uuid)` : sql``}
    ORDER BY ${order} DESC, m.id DESC
    LIMIT ${limit + 1}
  `;
  const candidates =
    folder === 'inbox'
      ? sql`SELECT id, sort_at FROM (
        (${candidatePage(sql`m.sent_at`, receivedInboxPredicate(sql))})
        UNION ALL
        (${candidatePage(sql`m.follow_up_at`, followUpPredicate(sql))})
      ) candidates ORDER BY sort_at DESC, id DESC LIMIT ${limit + 1}`
      : candidatePage(sortAt, folderPredicate(sql, folder, labelName));
  return sql`
    WITH page AS MATERIALIZED (${candidates})
    SELECT m.id, m.from_name, m.from_address,
           CASE WHEN jsonb_typeof(m.recipients) = 'string'
                THEN (m.recipients #>> '{}')::jsonb
                ELSE m.recipients END AS recipients,
           m.subject, m.snippet, ${sortAt} AS sort_at,
           to_char((${sortAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_cursor,
           m.sent_at, m.is_unread, m.is_starred, m.screening_status,
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
           ) AS labels,
           CASE WHEN c.id IS NULL THEN NULL
                ELSE json_build_object('id', c.id, 'name', c.name, 'color', c.color)
           END AS category
    FROM page JOIN messages m ON m.id = page.id
    JOIN threads t ON t.id = m.thread_id AND t.user_id = m.user_id
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    LEFT JOIN email_categories c ON c.id = m.category_id AND c.user_id = m.user_id
    LEFT JOIN message_labels ml ON ml.message_id = m.id
    LEFT JOIN labels l ON l.id = ml.label_id
    WHERE m.user_id = ${userId}
    GROUP BY m.id, ai.spam_score, ai.spam_verdict, ai.priority, c.id
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
             WHERE ai.status = 'completed'
               AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
           )::int AS unread
    FROM messages m
    LEFT JOIN message_ai ai ON ai.message_id = m.id
    WHERE m.user_id = ${userId} AND m.is_unread
      AND m.screening_status = 'allowed'
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
      AND m.screening_status = 'allowed'
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
      AND m.screening_status = 'allowed'
      AND NOT m.is_deleted AND NOT m.is_archived AND NOT m.is_sent
      AND COALESCE(ai.spam_verdict, 'inbox') <> 'spam'
      AND m.scheduled_for > now()
  `;
}

// How many Send Later messages are still waiting. The sidebar lists the
// Scheduled folder only while this is non-zero, and it used to learn that
// from a separate boot-time request to the Vercel /api/send function; it
// rides with the other folder counts instead. Same predicate as the
// pending queue in cookie-web-send's scheduled.js.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export function fetchScheduledCount(sql, userId) {
  return sql`
    SELECT count(*)::int AS scheduled
    FROM scheduled_sends s
    WHERE s.user_id = ${userId} AND s.status IN ('pending', 'failed')
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
    const [[userRow], [spamRow], [snoozedRow], [scheduledRow]] = await Promise.all([
      fetchUnreadCount(sql, userId),
      fetchSpamCount(sql, userId),
      fetchSnoozedCount(sql, userId),
      fetchScheduledCount(sql, userId),
    ]);
    return Response.json({
      unreadCount: userRow?.unread ?? 0,
      spamCount: spamRow?.spam ?? 0,
      snoozedCount: snoozedRow?.snoozed ?? 0,
      scheduledCount: scheduledRow?.scheduled ?? 0,
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

  const timing = createTimings();
  try {
    // The unread and spam counts only matter on a list's first page; the
    // client ignores them on cursor pages, so skip the aggregates there.
    const [rows, [userRow], [spamRow], [snoozedRow], [scheduledRow]] = await Promise.all([
      timing.run('list', () => fetchEmails(sql, userId, limit, cursor, folder, labelName)),
      cursor ? [] : timing.run('unread', () => fetchUnreadCount(sql, userId)),
      cursor ? [] : timing.run('spam', () => fetchSpamCount(sql, userId)),
      cursor ? [] : timing.run('snoozed', () => fetchSnoozedCount(sql, userId)),
      cursor ? [] : timing.run('scheduled', () => fetchScheduledCount(sql, userId)),
    ]);
    const hasMore = rows.length > limit;
    const emails = hasMore ? rows.slice(0, limit) : rows;
    const last = emails[emails.length - 1];
    const publicEmails = emails.map((row) => {
      const email = { ...row };
      delete email.sort_at;
      delete email.sort_cursor;
      return email;
    });
    /** @type {Record<string, unknown>} */
    const payload = {
      emails: publicEmails,
      // Preserve PostgreSQL microseconds through both the JSON cursor and
      // text-typed SQL binding; postgres.js Date serialization truncates them.
      nextCursor: hasMore ? `${last.sort_cursor ?? last.sort_at.toISOString()}|${last.id}` : null,
      readReceiptsAvailable: folder === 'sent',
    };
    if (!cursor) {
      payload.unreadCount = userRow?.unread ?? 0;
      payload.spamCount = spamRow?.spam ?? 0;
      payload.snoozedCount = snoozedRow?.snoozed ?? 0;
      payload.scheduledCount = scheduledRow?.scheduled ?? 0;
      payload.userId = userId;
    }
    return timing.response(Response.json(payload));
  } catch (err) {
    console.error('GET /emails failed:', err);
    return Response.json({ error: 'Failed to load emails' }, { status: 500 });
  }
}
