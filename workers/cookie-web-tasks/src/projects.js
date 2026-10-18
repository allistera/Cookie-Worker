// Cookie-owned projects for the Tasks app. Shaped after documents.js: the
// same id/text validation, the same user-scoped statements, and a flat list
// on GET that the client assembles into a tree.

import { isAncestorOf } from './ancestry.js';
import { attachmentKeysOf, deleteVanishedAttachments } from './taskComments.js';
import { validId } from '../../../shared/pagination.js';

const MAX_NAME_LENGTH = 120;

/** @param {any} value */
function cleanName(value) {
  if (!(value?.trim instanceof Function)) return null;
  const name = value.trim().slice(0, MAX_NAME_LENGTH);
  return name || null;
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {string} id */
function fetchOwnedProject(sql, userId, id) {
  return sql`SELECT id FROM task_projects WHERE id = ${id} AND user_id = ${userId}`;
}

/**
 * GET /projects — every project the caller owns, ordered by name. Flat, not
 * nested: the sidebar builds the tree client-side. Counts cover unfinished
 * top-level tasks directly in each project, independent of task pagination.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function getProjects(sql, userId) {
  const projects = await sql`
    SELECT p.id, p.parent_id AS "parentId", p.name, p.description, p.is_favorite AS "isFavorite", p.created_at AS "createdAt",
           (SELECT count(*)::int FROM task_items t
             WHERE t.user_id = p.user_id AND t.project_id = p.id
               AND t.kind = 'task' AND t.parent_id IS NULL
               AND t.completed_at IS NULL) AS "taskCount"
    FROM task_projects p
    WHERE p.user_id = ${userId}
    ORDER BY p.name ASC
  `;
  return Response.json({ projects });
}

/**
 * POST /projects — { name, parentId? }.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function createProject(sql, userId, body) {
  const name = cleanName(body?.name);
  if (!name) return Response.json({ error: 'A project name is required' }, { status: 400 });

  const parentId = body?.parentId ?? null;
  if (parentId !== null) {
    if (!validId(parentId) || !(await fetchOwnedProject(sql, userId, parentId)).length) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }
  }

  const [project] = await sql`
    INSERT INTO task_projects (user_id, parent_id, name)
    VALUES (${userId}, ${parentId}, ${name})
    RETURNING id, parent_id AS "parentId", name, description, is_favorite AS "isFavorite", created_at AS "createdAt", 0 AS "taskCount"
  `;
  return Response.json({ project }, { status: 201 });
}

/**
 * PATCH /projects — { id, name?, parentId?, description?, isFavorite? }. parentId: null moves the
 * project to the root.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function updateProject(sql, userId, body) {
  // The cycle check and the reparent must be atomic: two concurrent opposite
  // moves (A under B, B under A) would otherwise both pass the check.
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 2))`;
    return updateProjectUnlocked(/** @type {any} */ (tx), userId, body);
  });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {any} body */
async function updateProjectUnlocked(sql, userId, body) {
  const id = validId(body?.id) ? String(body.id) : null;
  if (!id) return Response.json({ error: 'A valid project id is required' }, { status: 400 });
  if (!(await fetchOwnedProject(sql, userId, id)).length) {
    return Response.json({ error: 'Project not found' }, { status: 404 });
  }

  const hasName = Object.hasOwn(body, 'name');
  const hasParent = Object.hasOwn(body, 'parentId');
  const hasFavorite = Object.hasOwn(body, 'isFavorite');
  if (hasFavorite && typeof body.isFavorite !== 'boolean') {
    return Response.json({ error: 'isFavorite must be a boolean' }, { status: 400 });
  }
  const hasDescription = Object.hasOwn(body, 'description');
  const name = hasName ? cleanName(body.name) : null;
  if (hasName && !name) {
    return Response.json({ error: 'A project name is required' }, { status: 400 });
  }
  if (!hasName && !hasParent && !hasDescription && !hasFavorite) {
    return Response.json({ error: 'At least one change is required' }, { status: 400 });
  }

  const description = hasDescription
    ? String(body.description ?? '')
        .trim()
        .slice(0, 10000) || null
    : null;

  const parentId = hasParent ? (body.parentId ?? null) : null;
  if (hasParent && parentId !== null) {
    if (parentId === id) {
      return Response.json({ error: 'A project cannot be its own parent' }, { status: 400 });
    }
    if (!validId(parentId) || !(await fetchOwnedProject(sql, userId, parentId)).length) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }
    if (
      await isAncestorOf(sql, {
        table: 'task_projects',
        userId,
        id,
        candidateParentId: parentId,
      })
    ) {
      return Response.json(
        { error: 'A project cannot become its own descendant' },
        { status: 400 },
      );
    }
  }

  const [project] = await sql`
    UPDATE task_projects p SET
      name        = COALESCE(${hasName ? name : null}, p.name),
      parent_id   = CASE WHEN ${hasParent}::boolean THEN ${parentId}::uuid ELSE p.parent_id END,
      description = CASE WHEN ${hasDescription}::boolean THEN ${description} ELSE p.description END,
      is_favorite = CASE WHEN ${hasFavorite}::boolean THEN ${hasFavorite ? body.isFavorite : false}::boolean ELSE p.is_favorite END
    WHERE p.id = ${id} AND p.user_id = ${userId}
    RETURNING p.id, p.parent_id AS "parentId", p.name, p.description, p.is_favorite AS "isFavorite", p.created_at AS "createdAt"
  `;
  return Response.json({ project });
}

/**
 * DELETE /projects — { id }. Sub-projects go with it via the schema's
 * ON DELETE CASCADE; nothing else references a project yet.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 * @param {any} [env] The FILES bucket, for the cascaded attachments.
 * @param {{report?: (operation: string, error: unknown, extra: Record<string, unknown>) => void}} [deps]
 *   Where a failed attachment-object delete is reported.
 */
export async function deleteProject(sql, userId, body, env, deps = {}) {
  const id = validId(body?.id) ? String(body.id) : null;
  if (!id) return Response.json({ error: 'A valid project id is required' }, { status: 400 });

  // Sub-projects and tasks cascade, and the tasks' threads with them; their
  // attachment objects are removed once the rows are gone (taskComments.js).
  // The key snapshot and the delete share the owner's task lock, so a
  // comment landing meanwhile is either in the snapshot or refused.
  const { attachmentKeys, deleted } = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 1))`;
    const keys = await attachmentKeysOf(/** @type {any} */ (tx), userId);
    const rows = await tx`
      DELETE FROM task_projects WHERE id = ${id} AND user_id = ${userId} RETURNING id
    `;
    return { attachmentKeys: keys, deleted: rows };
  });
  if (!deleted.length) return Response.json({ error: 'Project not found' }, { status: 404 });
  await deleteVanishedAttachments(sql, env ?? {}, userId, attachmentKeys, deps);
  return Response.json({ ok: true });
}
