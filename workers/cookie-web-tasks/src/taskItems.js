// Cookie-owned tasks. Distinct from `tasks`, which holds the overnight
// enricher's gathered Todoist and email items and is not a place a person
// writes to. The two never share a row.

import { isAncestorOf } from './ancestry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONTENT_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 10000;

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
 * GET /task-items?project=<uuid|inbox>[&completed=1]
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
  if (!inbox && !isUuid(project)) {
    return Response.json({ error: 'project must be a project id or "inbox"' }, { status: 400 });
  }
  const projectId = inbox ? null : project;
  const includeCompleted = url.searchParams.get('completed') === '1';

  const items = await sql`
    SELECT t.id, t.project_id AS "projectId", t.parent_id AS "parentId", t.content,
           t.description, t.due_date AS "dueDate", t.completed_at AS "completedAt",
           t.created_at AS "createdAt"
    FROM task_items t
    WHERE t.user_id = ${userId}
      AND CASE WHEN ${inbox}::boolean THEN t.project_id IS NULL
               ELSE t.project_id = ${projectId}::uuid END
      AND (${includeCompleted}::boolean OR t.completed_at IS NULL)
    ORDER BY t.created_at ASC
  `;
  return Response.json({ items });
}

/**
 * POST /task-items — { content, description?, projectId?, parentId?, dueDate? }
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function createTaskItem(sql, userId, body) {
  const content = cleanText(body?.content, MAX_CONTENT_LENGTH);
  if (!content) return Response.json({ error: 'Task content is required' }, { status: 400 });

  const description = Object.hasOwn(body ?? {}, 'description')
    ? cleanText(body.description, MAX_DESCRIPTION_LENGTH)
    : null;

  const projectId = body?.projectId ?? null;
  if (projectId !== null) {
    if (!isUuid(projectId) || !(await fetchOwnedProject(sql, userId, projectId)).length) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }
  }

  const dueDate = DATE_RE.test(String(body?.dueDate ?? '')) ? String(body.dueDate) : null;

  const [item] = await sql`
    INSERT INTO task_items (user_id, project_id, content, description, due_date)
    VALUES (${userId}, ${projectId}, ${content}, ${description}, ${dueDate})
    RETURNING id, project_id AS "projectId", parent_id AS "parentId", content, description,
              due_date AS "dueDate", completed_at AS "completedAt", created_at AS "createdAt"
  `;
  return Response.json({ item }, { status: 201 });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {string} id */
function fetchOwnedTaskItem(sql, userId, id) {
  return sql`SELECT id FROM task_items WHERE id = ${id} AND user_id = ${userId}`;
}

/**
 * PATCH /task-items — { id, content?, description?, projectId?, parentId?,
 * dueDate?, completed? }. projectId: null moves the task to the Inbox.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function updateTaskItem(sql, userId, body) {
  const id = isUuid(body?.id) ? String(body.id) : null;
  if (!id) return Response.json({ error: 'A valid task id is required' }, { status: 400 });
  if (!(await fetchOwnedTaskItem(sql, userId, id)).length) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  const hasContent = Object.hasOwn(body, 'content');
  const hasDescription = Object.hasOwn(body, 'description');
  const hasProject = Object.hasOwn(body, 'projectId');
  const hasParent = Object.hasOwn(body, 'parentId');
  const hasDueDate = Object.hasOwn(body, 'dueDate');
  const hasCompleted = Object.hasOwn(body, 'completed');

  const content = hasContent ? cleanText(body.content, MAX_CONTENT_LENGTH) : null;
  if (hasContent && !content) {
    return Response.json({ error: 'Task content is required' }, { status: 400 });
  }
  if (!hasContent && !hasDescription && !hasProject && !hasParent && !hasDueDate && !hasCompleted) {
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

  const dueDate =
    hasDueDate && DATE_RE.test(String(body.dueDate ?? '')) ? String(body.dueDate) : null;

  const [item] = await sql`
    UPDATE task_items t SET
      content      = COALESCE(${hasContent ? content : null}, t.content),
      description  = CASE WHEN ${hasDescription}::boolean THEN ${description} ELSE t.description END,
      project_id   = CASE WHEN ${hasProject}::boolean THEN ${projectId}::uuid ELSE t.project_id END,
      parent_id    = CASE WHEN ${hasParent}::boolean THEN ${parentId}::uuid ELSE t.parent_id END,
      due_date     = CASE WHEN ${hasDueDate}::boolean THEN ${dueDate}::date ELSE t.due_date END,
      completed_at = CASE
        WHEN ${hasCompleted}::boolean THEN (CASE WHEN ${Boolean(body.completed)}::boolean THEN now() ELSE NULL END)
        ELSE t.completed_at
      END,
      updated_at   = now()
    WHERE t.id = ${id} AND t.user_id = ${userId}
    RETURNING t.id, t.project_id AS "projectId", t.parent_id AS "parentId", t.content,
              t.description, t.due_date AS "dueDate", t.completed_at AS "completedAt",
              t.created_at AS "createdAt"
  `;
  return Response.json({ item });
}
