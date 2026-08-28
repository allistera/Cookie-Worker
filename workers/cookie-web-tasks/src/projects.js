// Cookie-owned projects for the Tasks app. Shaped after documents.js: the
// same id/text validation, the same user-scoped statements, and a flat list
// on GET that the client assembles into a tree.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 120;

/** @param {any} value */
function isUuid(value) {
  return value === String(value ?? '') && UUID_RE.test(value);
}

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
 * nested: the sidebar builds the tree client-side.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function getProjects(sql, userId) {
  const projects = await sql`
    SELECT p.id, p.parent_id AS "parentId", p.name, p.created_at AS "createdAt"
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
    if (!isUuid(parentId) || !(await fetchOwnedProject(sql, userId, parentId)).length) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }
  }

  const [project] = await sql`
    INSERT INTO task_projects (user_id, parent_id, name)
    VALUES (${userId}, ${parentId}, ${name})
    RETURNING id, parent_id AS "parentId", name, created_at AS "createdAt"
  `;
  return Response.json({ project }, { status: 201 });
}

/**
 * True when `projectId` sits on the ancestry chain above `candidateParentId`,
 * which is exactly the case where re-parenting would create a cycle. The walk
 * climbs from the proposed parent to the root, so it terminates on the tree's
 * depth rather than its size.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} projectId
 * @param {string} candidateParentId
 */
export async function isAncestorOf(sql, userId, projectId, candidateParentId) {
  const rows = await sql`
    WITH RECURSIVE ancestry AS (
      SELECT id, parent_id FROM task_projects
      WHERE id = ${candidateParentId} AND user_id = ${userId}
      UNION ALL
      SELECT p.id, p.parent_id FROM task_projects p
      JOIN ancestry a ON p.id = a.parent_id AND p.user_id = ${userId}
    )
    SELECT 1 FROM ancestry WHERE id = ${projectId} LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * PATCH /projects — { id, name?, parentId? }. parentId: null moves the
 * project to the root.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function updateProject(sql, userId, body) {
  const id = isUuid(body?.id) ? String(body.id) : null;
  if (!id) return Response.json({ error: 'A valid project id is required' }, { status: 400 });
  if (!(await fetchOwnedProject(sql, userId, id)).length) {
    return Response.json({ error: 'Project not found' }, { status: 404 });
  }

  const hasName = Object.hasOwn(body, 'name');
  const hasParent = Object.hasOwn(body, 'parentId');
  const name = hasName ? cleanName(body.name) : null;
  if (hasName && !name) {
    return Response.json({ error: 'A project name is required' }, { status: 400 });
  }
  if (!hasName && !hasParent) {
    return Response.json({ error: 'At least one change is required' }, { status: 400 });
  }

  const parentId = hasParent ? (body.parentId ?? null) : null;
  if (hasParent && parentId !== null) {
    if (parentId === id) {
      return Response.json({ error: 'A project cannot be its own parent' }, { status: 400 });
    }
    if (!isUuid(parentId) || !(await fetchOwnedProject(sql, userId, parentId)).length) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }
    if (await isAncestorOf(sql, userId, id, parentId)) {
      return Response.json(
        { error: 'A project cannot become its own descendant' },
        { status: 400 },
      );
    }
  }

  const [project] = await sql`
    UPDATE task_projects p SET
      name      = COALESCE(${hasName ? name : null}, p.name),
      parent_id = CASE WHEN ${hasParent}::boolean THEN ${parentId}::uuid ELSE p.parent_id END
    WHERE p.id = ${id} AND p.user_id = ${userId}
    RETURNING p.id, p.parent_id AS "parentId", p.name, p.created_at AS "createdAt"
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
 */
export async function deleteProject(sql, userId, body) {
  const id = isUuid(body?.id) ? String(body.id) : null;
  if (!id) return Response.json({ error: 'A valid project id is required' }, { status: 400 });

  const deleted = await sql`
    DELETE FROM task_projects WHERE id = ${id} AND user_id = ${userId} RETURNING id
  `;
  if (!deleted.length) return Response.json({ error: 'Project not found' }, { status: 404 });
  return Response.json({ ok: true });
}
