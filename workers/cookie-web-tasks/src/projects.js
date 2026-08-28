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
