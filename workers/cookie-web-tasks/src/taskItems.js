// Cookie-owned tasks. Distinct from `tasks`, which holds the overnight
// enricher's gathered email action items and is not a place a person writes
// to. The two never share a row.

import { isAncestorOf } from './ancestry.js';
import { removeTaskItemFromMeili, syncTaskItemToMeili } from './taskItemMeiliSync.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONTENT_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 10000;
// Todoist-style: 1 is the most urgent, 4 is the default and shows as "no
// priority". Mirrors the CHECK on task_items.priority (migration 0058).
const MIN_PRIORITY = 1;
const MAX_PRIORITY = 4;
export const DEFAULT_PRIORITY = MAX_PRIORITY;

/**
 * A real calendar date in YYYY-MM-DD. DATE_RE alone admits 2026-02-31, which
 * Postgres refuses at the ::date cast — a 500 where the caller deserves a 400.
 *
 * @param {any} value
 */
export function isCalendarDate(value) {
  const text = String(value ?? '');
  if (!DATE_RE.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * An integer in 1..4. Strings are refused even when numeric: the wire is
 * JSON and a client that sends "2" has a bug worth hearing about, not one
 * worth papering over.
 *
 * @param {any} value
 */
export function isPriority(value) {
  return Number.isInteger(value) && value >= MIN_PRIORITY && value <= MAX_PRIORITY;
}

/** @param {any} value */
function isUuid(value) {
  return value === String(value ?? '') && UUID_RE.test(value);
}

/** @param {any} value @param {number} max */
function cleanText(value, max) {
  if (!(value?.trim instanceof Function)) return null;
  const text = value.trim().slice(0, max);
  return text || null;
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {string} id */
function fetchOwnedProject(sql, userId, id) {
  return sql`SELECT id FROM task_projects WHERE id = ${id} AND user_id = ${userId}`;
}

/**
 * GET /task-items?project=<uuid|inbox|today>[&date=YYYY-MM-DD][&completed=1]
 *
 * `today` spans every project, so it is a third branch of the same flat query
 * rather than a project filter. Its date comes from the caller: the Worker
 * cannot know what "today" is where the person is standing, and defaulting to
 * UTC would show the wrong day for most of the world for part of every day.
 *
 * It matches on or before that date, so anything overdue is carried forward
 * rather than disappearing the moment its day passes — an unfinished task
 * would otherwise be visible only inside its own project.
 *
 * The WHERE clause is one flat parameterised query rather than composed from
 * nested sql`` fragments: fragment composition is valid postgres.js, but the
 * test mock (createMockSql) evaluates a nested fragment as a plain call
 * before the outer template runs, which records an extra call and shifts the
 * FIFO result queue out from under every later query. A single query with
 * plain boolean/value parameters keeps one call per request.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 */
export async function getTaskItems(sql, userId, url) {
  const project = url.searchParams.get('project') ?? 'inbox';
  const inbox = project === 'inbox';
  const today = project === 'today';
  if (!inbox && !today && !isUuid(project)) {
    return Response.json(
      { error: 'project must be a project id, "inbox" or "today"' },
      { status: 400 },
    );
  }

  const date = url.searchParams.get('date');
  if (today && !isCalendarDate(date)) {
    return Response.json({ error: 'today requires a date=YYYY-MM-DD' }, { status: 400 });
  }

  const projectId = inbox || today ? null : project;
  const includeCompleted = url.searchParams.get('completed') === '1';

  const items = await sql`
    SELECT t.id, t.project_id AS "projectId", t.parent_id AS "parentId", t.content,
           t.description, to_char(t.due_date, 'YYYY-MM-DD') AS "dueDate", t.priority,
           t.completed_at AS "completedAt", t.created_at AS "createdAt"
    FROM task_items t
    WHERE t.user_id = ${userId}
      -- Today also carries the sub-tasks of every task it lists: the panel
      -- resolves sub-tasks out of the loaded list, and a sub-task rarely has
      -- a due date of its own to qualify on.
      AND CASE WHEN ${today}::boolean THEN (t.due_date <= ${today ? date : null}::date
                 OR EXISTS (SELECT 1 FROM task_items p
                            WHERE p.id = t.parent_id AND p.user_id = ${userId}
                              AND p.due_date <= ${today ? date : null}::date))
               WHEN ${inbox}::boolean THEN t.project_id IS NULL
               ELSE t.project_id = ${projectId}::uuid END
      -- Completed sub-tasks stay listed: the panel shows them checked and
      -- counts them into its "done/total" progress. Only completed top-level
      -- tasks leave the list.
      AND (${includeCompleted}::boolean OR t.completed_at IS NULL OR t.parent_id IS NOT NULL)
    -- Only Today sorts by date: it is the one list where the rows carry
    -- different due dates, and the oldest thing owed belongs at the top.
    -- Project and Inbox lists keep their created_at order.
    ORDER BY CASE WHEN ${today}::boolean THEN t.due_date END ASC NULLS LAST, t.created_at ASC
  `;
  return Response.json({ items });
}

/**
 * POST /task-items — { content, description?, projectId?, dueDate?,
 * priority?, parentId? }. A sub-task lives in its parent's project: with parentId set,
 * the project is read from the parent row and any projectId in the body is
 * ignored, so the two can never disagree.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {any} [env] Meilisearch config for the best-effort search sync.
 */
export async function createTaskItem(sql, userId, body, env) {
  const content = cleanText(body?.content, MAX_CONTENT_LENGTH);
  if (!content) return Response.json({ error: 'Task content is required' }, { status: 400 });

  const description = Object.hasOwn(body ?? {}, 'description')
    ? cleanText(body.description, MAX_DESCRIPTION_LENGTH)
    : null;

  const parentId = body?.parentId ?? null;
  let projectId = body?.projectId ?? null;
  if (parentId !== null) {
    if (!isUuid(parentId)) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }
    const [parent] = await sql`
      SELECT id, project_id AS "projectId" FROM task_items
      WHERE id = ${parentId} AND user_id = ${userId}
    `;
    if (!parent) return Response.json({ error: 'Task not found' }, { status: 404 });
    projectId = parent.projectId;
  } else if (projectId !== null) {
    if (!isUuid(projectId) || !(await fetchOwnedProject(sql, userId, projectId)).length) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }
  }

  const hasDueDate = body?.dueDate !== undefined && body?.dueDate !== null && body?.dueDate !== '';
  if (hasDueDate && !isCalendarDate(body.dueDate)) {
    return Response.json({ error: 'dueDate must be a YYYY-MM-DD date' }, { status: 400 });
  }
  const dueDate = hasDueDate ? String(body.dueDate) : null;

  // Absent or null means the default; anything else must be a real priority.
  const hasPriority = body?.priority !== undefined && body?.priority !== null;
  if (hasPriority && !isPriority(body.priority)) {
    return Response.json({ error: 'priority must be an integer from 1 to 4' }, { status: 400 });
  }
  const priority = hasPriority ? body.priority : DEFAULT_PRIORITY;

  const [item] = await sql`
    INSERT INTO task_items (user_id, project_id, parent_id, content, description, due_date, priority)
    VALUES (${userId}, ${projectId}, ${parentId}, ${content}, ${description}, ${dueDate}, ${priority})
    RETURNING id, project_id AS "projectId", parent_id AS "parentId", content, description,
              to_char(due_date, 'YYYY-MM-DD') AS "dueDate", priority, completed_at AS "completedAt",
              created_at AS "createdAt"
  `;
  // Best-effort: a sub-task lands on its parent's search document (the sync
  // walks up to the root), a top-level task gets its own.
  await syncTaskItemToMeili(sql, env, item.id);
  return Response.json({ item }, { status: 201 });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {string} id */
function fetchOwnedTaskItem(sql, userId, id) {
  return sql`SELECT id, parent_id AS "parentId" FROM task_items WHERE id = ${id} AND user_id = ${userId}`;
}

/**
 * PATCH /task-items — { id, content?, description?, projectId?, parentId?,
 * dueDate?, priority?, completed? }. projectId: null moves the task to the
 * Inbox; priority: null resets it to the default (4).
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {any} [env] Meilisearch config for the best-effort search sync.
 */
export async function updateTaskItem(sql, userId, body, env) {
  const id = isUuid(body?.id) ? String(body.id) : null;
  if (!id) return Response.json({ error: 'A valid task id is required' }, { status: 400 });
  const [existing] = await fetchOwnedTaskItem(sql, userId, id);
  if (!existing) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  const hasContent = Object.hasOwn(body, 'content');
  const hasDescription = Object.hasOwn(body, 'description');
  const hasProject = Object.hasOwn(body, 'projectId');
  const hasParent = Object.hasOwn(body, 'parentId');
  const hasDueDate = Object.hasOwn(body, 'dueDate');
  const hasPriority = Object.hasOwn(body, 'priority');
  const hasCompleted = Object.hasOwn(body, 'completed');

  const content = hasContent ? cleanText(body.content, MAX_CONTENT_LENGTH) : null;
  if (hasContent && !content) {
    return Response.json({ error: 'Task content is required' }, { status: 400 });
  }
  if (
    !hasContent &&
    !hasDescription &&
    !hasProject &&
    !hasParent &&
    !hasDueDate &&
    !hasPriority &&
    !hasCompleted
  ) {
    return Response.json({ error: 'At least one change is required' }, { status: 400 });
  }

  const description = hasDescription ? cleanText(body.description, MAX_DESCRIPTION_LENGTH) : null;

  const projectId = hasProject ? (body.projectId ?? null) : null;
  if (hasProject && projectId !== null) {
    if (!isUuid(projectId) || !(await fetchOwnedProject(sql, userId, projectId)).length) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }
  }

  const parentId = hasParent ? (body.parentId ?? null) : null;
  if (hasParent && parentId !== null) {
    if (parentId === id) {
      return Response.json({ error: 'A task cannot be its own parent' }, { status: 400 });
    }
    if (!isUuid(parentId) || !(await fetchOwnedTaskItem(sql, userId, parentId)).length) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }
    if (await isAncestorOf(sql, { table: 'task_items', userId, id, candidateParentId: parentId })) {
      return Response.json({ error: 'A task cannot become its own descendant' }, { status: 400 });
    }
  }

  // A malformed date must be refused, not quietly turned into null: that wrote
  // an empty due_date over whatever the task already had. An explicit null (or
  // '') still means "clear the date", which is a real request.
  const clearsDueDate = hasDueDate && (body.dueDate === null || body.dueDate === '');
  if (hasDueDate && !clearsDueDate && !isCalendarDate(body.dueDate)) {
    return Response.json({ error: 'dueDate must be a YYYY-MM-DD date' }, { status: 400 });
  }
  const dueDate = !hasDueDate || clearsDueDate ? null : String(body.dueDate);

  // Same bargain as dueDate: a bad value is refused, never coerced. null is
  // the one non-integer accepted, and it means "back to the default".
  const clearsPriority = hasPriority && body.priority === null;
  if (hasPriority && !clearsPriority && !isPriority(body.priority)) {
    return Response.json({ error: 'priority must be an integer from 1 to 4' }, { status: 400 });
  }
  const priority = !hasPriority || clearsPriority ? DEFAULT_PRIORITY : body.priority;

  const [item] = await sql`
    UPDATE task_items t SET
      content      = COALESCE(${hasContent ? content : null}, t.content),
      description  = CASE WHEN ${hasDescription}::boolean THEN ${description} ELSE t.description END,
      project_id   = CASE WHEN ${hasProject}::boolean THEN ${projectId}::uuid ELSE t.project_id END,
      parent_id    = CASE WHEN ${hasParent}::boolean THEN ${parentId}::uuid ELSE t.parent_id END,
      due_date     = CASE WHEN ${hasDueDate}::boolean THEN ${dueDate}::date ELSE t.due_date END,
      priority     = CASE WHEN ${hasPriority}::boolean THEN ${priority}::smallint ELSE t.priority END,
      completed_at = CASE
        WHEN ${hasCompleted}::boolean THEN (CASE WHEN ${Boolean(body.completed)}::boolean THEN now() ELSE NULL END)
        ELSE t.completed_at
      END,
      updated_at   = now()
    WHERE t.id = ${id} AND t.user_id = ${userId}
    RETURNING t.id, t.project_id AS "projectId", t.parent_id AS "parentId", t.content,
              t.description, to_char(t.due_date, 'YYYY-MM-DD') AS "dueDate", t.priority,
              t.completed_at AS "completedAt", t.created_at AS "createdAt"
  `;
  // Best-effort search sync. Reparenting moves the row between search
  // documents (only top-level tasks are indexed, carrying their sub-task
  // titles): a demoted task loses its own document, and an old parent must
  // re-push without the departed sub-task. The API allows reparenting even
  // though the UI never sends it today.
  if (hasParent && item.parentId !== existing.parentId) {
    if (existing.parentId === null) await removeTaskItemFromMeili(env, item.id);
    else await syncTaskItemToMeili(sql, env, existing.parentId);
  }
  await syncTaskItemToMeili(sql, env, item.id);
  return Response.json({ item });
}

/**
 * DELETE /task-items — { id }. Sub-tasks go with it via ON DELETE CASCADE.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {any} [env] Meilisearch config for the best-effort search sync.
 */
export async function deleteTaskItem(sql, userId, body, env) {
  const id = isUuid(body?.id) ? String(body.id) : null;
  if (!id) return Response.json({ error: 'A valid task id is required' }, { status: 400 });

  const deleted = await sql`
    DELETE FROM task_items WHERE id = ${id} AND user_id = ${userId} RETURNING id, parent_id AS "parentId"
  `;
  if (!deleted.length) return Response.json({ error: 'Task not found' }, { status: 404 });
  // A top-level task takes its search document (sub-task titles and all) with
  // it; a deleted sub-task means its parent's document re-pushes without it.
  if (deleted[0].parentId === null) await removeTaskItemFromMeili(env, id);
  else await syncTaskItemToMeili(sql, env, deleted[0].parentId);
  return Response.json({ ok: true });
}
