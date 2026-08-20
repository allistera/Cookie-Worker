// Ported from Cookie-Web's api/tasks.js — the GET (tasks + digest + news) and
// POST (complete/reschedule) handlers for AI Today's task list. Behaviorally
// identical; only the (req, res) mutation style becomes returning a
// Response, and the Todoist API token is passed in explicitly rather than
// read from process.env.

const RESULTS = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The authenticated user's gathered tasks (Todoist tasks + AI-extracted email
// action items), most-pressing first: soonest due, then highest priority.
// Scoped to due today or overdue - AI Today is a daily view, so anything due
// later would just be backlog noise here. A task with no due date at all has
// no "today" claim to make either way, but is shown anyway since there is no
// future date to defer it by.
/** @param {import('postgres').Sql} sql @param {string} userId */
export function fetchTasks(sql, userId) {
  return sql`
    SELECT t.id, t.source, t.content, t.description, t.due_date,
           t.priority, t.url, t.message_id, t.gathered_at,
           m.from_address AS reply_to, m.subject AS message_subject
    FROM tasks t
    LEFT JOIN messages m ON m.id = t.message_id AND m.user_id = t.user_id
    WHERE t.user_id = ${userId}
      AND (t.due_date IS NULL OR t.due_date <= CURRENT_DATE)
    ORDER BY t.due_date ASC NULLS LAST, t.priority DESC NULLS LAST, t.created_at DESC
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
    SELECT m.id, m.is_unread, m.scheduled_for
    FROM messages m
    WHERE m.user_id = ${userId}
      AND m.id = ANY(${ids}::uuid[])
      AND NOT m.is_deleted
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

// One gathered task owned by the caller, returning what completion needs.
/** @param {import('postgres').Sql} sql @param {string} id @param {string} userId */
export function fetchOwnedTask(sql, id, userId) {
  return sql`
    SELECT t.id, t.source, t.external_id
    FROM tasks t
    WHERE t.id = ${id} AND t.user_id = ${userId}
  `;
}

// Completing a task removes it from the gathered set; there is no done column.
// A closed Todoist task is no longer "due today", so the daily enricher will
// not re-add it.
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

// Close a task in Todoist via the unified API (api.todoist.com/api/v1). The
// deprecated REST v2 base returns 410 Gone. Throws on any non-2xx response.
/** @param {string} externalId @param {string} token */
export async function closeTodoistTask(externalId, token) {
  const response = await fetch(
    `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(externalId)}/close`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) {
    throw new Error(`Todoist close responded ${response.status}`);
  }
}

// Reschedule a task in Todoist via the unified API (api.todoist.com/api/v1).
// dueDate is a plain YYYY-MM-DD date, matching this codebase's `date` column.
// Throws on any non-2xx response.
/** @param {string} externalId @param {string} token @param {string} dueDate */
export async function rescheduleTodoistTask(externalId, token, dueDate) {
  const response = await fetch(
    `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(externalId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ due_date: dueDate }),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) {
    throw new Error(`Todoist reschedule responded ${response.status}`);
  }
}

// Completes a task: the real Todoist task is closed before dropping our copy,
// so a failed close leaves the task visible instead of silently vanishing.
// Without a token configured we fall back to clearing it from Cookie only.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} task
 * @param {string | undefined} todoistToken
 */
async function completeTask(sql, userId, task, todoistToken) {
  const closedInTodoist = task.source === 'todoist' && Boolean(todoistToken);
  if (closedInTodoist) {
    try {
      await closeTodoistTask(task.external_id, /** @type {string} */ (todoistToken));
    } catch (err) {
      console.log(
        JSON.stringify({
          event: 'todoist_close_failed',
          message: /** @type {Error} */ (err).message,
        }),
      );
      return Response.json({ error: 'Failed to close the task in Todoist' }, { status: 502 });
    }
  }

  await deleteOwnedTask(sql, task.id, userId);
  return Response.json({ ok: true, closedInTodoist });
}

// Reschedules a task to another day. A Todoist-sourced task is rescheduled in
// Todoist first (when a Todoist token is configured) - the daily sync
// otherwise clobbers a local-only due_date change back to whatever Todoist
// still reports the next time it runs. A failed Todoist call leaves the task
// on its original day instead of drifting out of sync with Todoist.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} task
 * @param {string} dueDate
 * @param {string | undefined} todoistToken
 */
async function rescheduleTask(sql, userId, task, dueDate, todoistToken) {
  if (task.source === 'todoist' && todoistToken) {
    try {
      await rescheduleTodoistTask(task.external_id, todoistToken, dueDate);
    } catch (err) {
      console.log(
        JSON.stringify({
          event: 'todoist_reschedule_failed',
          message: /** @type {Error} */ (err).message,
        }),
      );
      return Response.json({ error: 'Failed to reschedule the task in Todoist' }, { status: 502 });
    }
  }

  const [updated] = await updateTaskDueDate(sql, task.id, userId, dueDate);
  return Response.json({ ok: true, task: updated });
}

// POST /tasks — { id, action: 'complete' } marks a gathered task done;
// { id, action: 'reschedule', due_date } moves it to another day.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {string | undefined} todoistToken
 */
export async function postTasks(sql, userId, body, todoistToken) {
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
  if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });

  return action === 'complete'
    ? completeTask(sql, userId, task, todoistToken)
    : rescheduleTask(sql, userId, task, /** @type {string} */ (dueDate), todoistToken);
}

// GET /tasks — { tasks: [...], digest: {...} | null, news: {...} | null } for
// the AI dashboard. All three are returned together because AI Today always
// renders all of them.
/** @param {import('postgres').Sql} sql @param {string} userId */
export async function getTasks(sql, userId) {
  const [tasks, [digestRow], [newsRow]] = await Promise.all([
    fetchTasks(sql, userId),
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
