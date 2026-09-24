// The GET (tasks + digest + news) and POST (complete/reschedule) handlers for
// AI Today's task list.

import { isCalendarDate, updateTaskItem } from './taskItems.js';

const RESULTS = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The authenticated user's gathered tasks, most-pressing first: soonest due,
// then highest priority. Two sources are unioned: AI-extracted email action
// items from the overnight enricher's `tasks` table (restricted to
// source = 'email' - any other row left over from a retired source is
// ignored), and Cookie's own built-in top-level task_items. Both are scoped
// to due today or overdue - AI Today is a daily view, so anything
// due later would just be backlog noise here. `date` lets the caller pick
// which day is "today"; a missing or invalid one falls back to the
// database's CURRENT_DATE. A gathered task with no due date at all has no
// "today" claim to make either way, but is shown anyway since there is no
// future date to defer it by; a task_item with no due date is backlog, not
// "today", so it is excluded rather than shown by default.
/** @param {import('postgres').Sql} sql @param {string} userId @param {string | null} date */
export function fetchTasks(sql, userId, date) {
  return sql`
    SELECT * FROM (
      SELECT t.id, t.source, t.content, t.description, t.due_date,
             t.priority, t.url, t.message_id, t.gathered_at,
             m.from_address AS reply_to, m.subject AS message_subject, t.created_at
      FROM tasks t
      LEFT JOIN messages m ON m.id = t.message_id AND m.user_id = t.user_id
      WHERE t.user_id = ${userId}
        AND t.source = 'email'
        AND (t.due_date IS NULL OR t.due_date <= COALESCE(${date}::date, CURRENT_DATE))
        -- An action item extracted from mail retires with its source: once
        -- the email is done, the work it described is handled.
        AND (t.message_id IS NULL OR (NOT m.is_archived AND m.screening_status = 'allowed'))
      UNION ALL
      SELECT t.id, 'task' AS source, t.content, t.description, t.due_date,
             NULL::smallint AS priority, NULL::text AS url, NULL::uuid AS message_id,
             NULL::timestamptz AS gathered_at, NULL::text AS reply_to,
             NULL::text AS message_subject, t.created_at
      FROM task_items t
      WHERE t.user_id = ${userId}
        AND t.parent_id IS NULL
        AND t.completed_at IS NULL
        AND t.due_date <= COALESCE(${date}::date, CURRENT_DATE)
    ) combined
    ORDER BY due_date ASC NULLS LAST, priority DESC NULLS LAST, created_at DESC
    LIMIT ${RESULTS}
  `;
}

// The newest whole-mailbox summary of a given kind, written by the
// data-enricher Worker: the legacy 'daily_digest' kind now carries three-tier
// inbox triage, while 'daily_news' carries the news round-up. These are the
// rows carrying no message_id.
/** @param {import('postgres').Sql} sql @param {string} userId @param {string} kind */
export function fetchLatestSummary(sql, userId, kind) {
  return sql`
    SELECT s.summary, s.raw, s.created_at
    FROM summaries s
    WHERE s.user_id = ${userId}
      AND s.kind = ${kind}
      AND s.message_id IS NULL
      -- A generated overview or topic title can mention a contributor that is
      -- no longer visible. Hide that whole snapshot, not just its linked items.
      AND (s.kind <> 'daily_digest' OR NOT EXISTS (
        SELECT 1 FROM messages held
        WHERE held.user_id = s.user_id AND held.screening_status <> 'allowed'
          AND CASE WHEN jsonb_typeof(s.raw -> 'source_message_ids') = 'array'
            THEN (s.raw -> 'source_message_ids') ? held.id::text
            ELSE held.created_at <= s.created_at AND held.sent_at > s.created_at - interval '1 day'
          END
      ))
    ORDER BY s.created_at DESC
    LIMIT 1
  `;
}

// Only ever hand the browser a real web link. The Worker already discards
// picks whose url was not among the candidates it fetched, but these links
// leave the app, so the render path does not take that on trust.
/** @param {any} url */
function safeLink(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

// Shape the stored news round-up for the client, dropping anything that is not
// a usable link.
/** @param {any} row */
export function buildNews(row) {
  if (!row) return null;
  const sections = [];
  for (const section of Array.isArray(row.raw?.sections) ? row.raw.sections : []) {
    const items = (Array.isArray(section?.items) ? section.items : [])
      .filter((/** @type {any} */ item) => safeLink(item?.url))
      .map((/** @type {any} */ item) => ({
        title: String(item.title ?? ''),
        url: item.url,
        description: String(item.description ?? ''),
        note: String(item.note ?? ''),
        meta: String(item.meta ?? ''),
      }));
    if (items.length > 0) {
      sections.push({
        emoji: String(section.emoji ?? ''),
        title: String(section.title ?? ''),
        items,
      });
    }
  }
  return { created_at: row.created_at, sections };
}

// Live state for the messages inbox triage cites. Triage is a snapshot from
// the overnight run, so by the time it is read some of its mail may have been
// read, archived or deleted. Archived mail stays included - archiving is how
// a topic gets dealt with, not a reason to hide it until tomorrow's digest;
// only deletion actually removes the message the topic is about.
/** @param {import('postgres').Sql} sql @param {string} userId @param {string[]} ids */
export function fetchMessageStates(sql, userId, ids) {
  return sql`
    SELECT m.id, m.is_unread, m.is_archived, m.scheduled_for
    FROM messages m
    WHERE m.user_id = ${userId}
      AND m.id = ANY(${ids}::uuid[])
      AND NOT m.is_deleted
      AND m.screening_status = 'allowed'
  `;
}

// Message ids the stored triage cites, in citation order. Written by a model,
// so anything that is not a plain uuid is discarded rather than reaching a
// ::uuid[] cast.
/** @param {any} row */
export function digestMessageIds(row) {
  const topics = Array.isArray(row?.raw?.topics) ? row.raw.topics : [];
  const ids = topics.flatMap((/** @type {any} */ topic) =>
    (Array.isArray(topic?.items) ? topic.items : []).map(
      (/** @type {any} */ item) => item?.message_id,
    ),
  );
  return [...new Set(ids.filter((/** @type {any} */ id) => UUID_RE.test(String(id))))];
}

// Fold live message state into stored triage: drop items whose message is
// deleted from the mailbox or has since been rescheduled to a later day, drop
// priority groups that empty, and mark what is still unread. Noise is already
// category-only, but is sanitized again before it reaches the browser because
// summaries.raw ultimately contains model data.
/** @param {any} row @param {any[]} states */
export function buildDigest(row, states) {
  if (!row) return null;
  const stateById = new Map(states.map((state) => [state.id, state]));
  const topics = [];
  for (const topic of Array.isArray(row.raw?.topics) ? row.raw.topics : []) {
    const items = (Array.isArray(topic?.items) ? topic.items : [])
      .filter((/** @type {any} */ item) => {
        const state = stateById.get(item?.message_id);
        if (!state) return false;
        // Done means handled, whether or not it was ever opened — a triage
        // list that keeps asking about finished mail is just noise.
        if (state.is_archived) return false;
        if (state.scheduled_for && new Date(state.scheduled_for) > new Date()) return false;
        return true;
      })
      .map((/** @type {any} */ item) => ({
        message_id: item.message_id,
        headline: String(item.headline ?? ''),
        note: String(item.note ?? ''),
        unread: stateById.get(item.message_id).is_unread,
      }));
    if (items.length > 0) {
      topics.push({ emoji: String(topic.emoji ?? ''), title: String(topic.title ?? ''), items });
    }
  }
  const categories = (Array.isArray(row.raw?.noise?.categories) ? row.raw.noise.categories : [])
    .map((/** @type {any} */ item) => ({
      category: item?.category?.trim?.() ?? '',
      count: item?.count,
    }))
    .filter(
      (/** @type {any} */ item) => item.category && Number.isInteger(item.count) && item.count > 0,
    );
  return {
    overview: row.summary ?? '',
    created_at: row.created_at,
    topics,
    noise: {
      count: categories.reduce(
        (/** @type {number} */ total, /** @type {any} */ item) => total + item.count,
        0,
      ),
      categories,
    },
  };
}

// One gathered task owned by the caller, scoped by id alone: postTasks tries
// this table first and falls back to task_items when it comes up empty.
/** @param {import('postgres').Sql} sql @param {string} id @param {string} userId */
export function fetchOwnedTask(sql, id, userId) {
  return sql`
    SELECT t.id
    FROM tasks t
    WHERE t.id = ${id} AND t.user_id = ${userId}
  `;
}

// Completing a gathered task removes it from the gathered set; there is no
// done column.
/** @param {import('postgres').Sql} sql @param {string} id @param {string} userId */
export function deleteOwnedTask(sql, id, userId) {
  return sql`
    DELETE FROM tasks t
    WHERE t.id = ${id} AND t.user_id = ${userId}
  `;
}

// Moves a gathered task's due date, taking it off today's list until then.
/** @param {import('postgres').Sql} sql @param {string} id @param {string} userId @param {string} dueDate */
export function updateTaskDueDate(sql, id, userId, dueDate) {
  return sql`
    UPDATE tasks t SET due_date = ${dueDate}
    WHERE t.id = ${id} AND t.user_id = ${userId}
    RETURNING t.id, t.due_date
  `;
}

// Completes a gathered task: it simply drops out of the gathered set.
/** @param {import('postgres').Sql} sql @param {string} userId @param {any} task */
async function completeTask(sql, userId, task) {
  await deleteOwnedTask(sql, task.id, userId);
  return Response.json({ ok: true });
}

// Reschedules a gathered task to another day.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} task
 * @param {string} dueDate
 */
async function rescheduleTask(sql, userId, task, dueDate) {
  const [updated] = await updateTaskDueDate(sql, task.id, userId, dueDate);
  return Response.json({ ok: true, task: updated });
}

// POST /tasks — { id, action: 'complete' } marks a task done; { id, action:
// 'reschedule', due_date } moves it to another day. The id may belong to
// either source: a gathered `tasks` row is tried first, and a miss there
// falls back to `task_items` via updateTaskItem, which owns that table's
// validation, ownership check and Meilisearch sync.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {any} env Meilisearch config, passed through to updateTaskItem.
 */
export async function postTasks(sql, userId, body, env) {
  const id = String(body.id ?? '');
  const { action } = body;
  if (!UUID_RE.test(id)) {
    return Response.json({ error: 'A valid task id is required' }, { status: 400 });
  }
  if (action !== 'complete' && action !== 'reschedule') {
    return Response.json({ error: "action must be 'complete' or 'reschedule'" }, { status: 400 });
  }

  /** @type {string | null} */
  let dueDate = null;
  if (action === 'reschedule') {
    dueDate = DATE_RE.test(String(body.due_date ?? '')) ? String(body.due_date) : null;
    if (!dueDate) {
      return Response.json({ error: 'A valid due_date (YYYY-MM-DD) is required' }, { status: 400 });
    }
  }

  const [task] = await fetchOwnedTask(sql, id, userId);
  if (task) {
    return action === 'complete'
      ? completeTask(sql, userId, task)
      : rescheduleTask(sql, userId, task, /** @type {string} */ (dueDate));
  }

  const itemBody = action === 'complete' ? { id, completed: true } : { id, dueDate };
  const response = await updateTaskItem(sql, userId, itemBody, env);
  if (!response.ok) return response;
  const { item } = /** @type {any} */ (await response.json());
  return action === 'complete'
    ? Response.json({ ok: true })
    : Response.json({ ok: true, task: { id: item.id, due_date: item.dueDate } });
}

// GET /tasks — { tasks: [...], digest: {...} | null, news: {...} | null } for
// the AI dashboard. All three are returned together because AI Today always
// renders all of them.
/** @param {import('postgres').Sql} sql @param {string} userId @param {URL} url */
export async function getTasks(sql, userId, url) {
  const rawDate = url.searchParams.get('date');
  const date = isCalendarDate(rawDate) ? rawDate : null;
  const [tasks, [digestRow], [newsRow]] = await Promise.all([
    fetchTasks(sql, userId, date),
    fetchLatestSummary(sql, userId, 'daily_digest'),
    fetchLatestSummary(sql, userId, 'daily_news'),
  ]);
  const ids = digestMessageIds(digestRow);
  const states = ids.length ? await fetchMessageStates(sql, userId, ids) : [];
  return Response.json({
    tasks,
    digest: buildDigest(digestRow, states),
    news: buildNews(newsRow),
  });
}
