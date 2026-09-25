// Managed labels for the Tasks app. task_items.labels keeps holding names
// (migration 0067); task_labels (0079) gives each name a row with a colour
// so it can be listed, renamed and deleted across every task. Shaped after
// projects.js: the same id validation, user-scoped statements and body
// shapes.

import { normalizeTaskLabels } from './taskMetadata.js';
import { validId } from '../../../shared/pagination.js';

const COLOR_RE = /^#[0-9a-f]{6}$/;
export const DEFAULT_LABEL_COLOR = '#64748b';

const BAD_NAME = 'Labels must be 1–40 characters without spaces, @, or #';
const BAD_COLOR = 'color must be a hex colour such as #1a73e8';

/**
 * One label name, normalised the way task writes normalise them, or null
 * when it cannot be a label.
 *
 * @param {any} value
 */
export function cleanLabelName(value) {
  if (typeof value !== 'string') return null;
  try {
    return normalizeTaskLabels([value])[0] ?? null;
  } catch {
    return null;
  }
}

/** @param {any} value */
export function cleanColor(value) {
  if (typeof value !== 'string') return null;
  const color = value.trim().toLowerCase();
  return COLOR_RE.test(color) ? color : null;
}

/**
 * GET /task-labels — every label the caller owns, by name, each with how
 * many of the caller's tasks carry it (the sidebar's delete confirmation
 * reads that count).
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function getTaskLabels(sql, userId) {
  const labels = await sql`
    SELECT l.id, l.name, l.color, l.created_at AS "createdAt",
           (SELECT count(*)::int FROM task_items t
             WHERE t.user_id = l.user_id AND t.labels @> ARRAY[l.name]) AS "taskCount"
    FROM task_labels l
    WHERE l.user_id = ${userId}
    ORDER BY l.name ASC
  `;
  return Response.json({ labels });
}

/**
 * POST /task-labels — { name, color? }.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function createTaskLabel(sql, userId, body) {
  const name = cleanLabelName(body?.name);
  if (!name) return Response.json({ error: BAD_NAME }, { status: 400 });
  const hasColor = body?.color !== undefined && body?.color !== null;
  const color = hasColor ? cleanColor(body.color) : DEFAULT_LABEL_COLOR;
  if (!color) return Response.json({ error: BAD_COLOR }, { status: 400 });

  const [label] = await sql`
    INSERT INTO task_labels (user_id, name, color)
    VALUES (${userId}, ${name}, ${color})
    ON CONFLICT (user_id, name) DO NOTHING
    RETURNING id, name, color, created_at AS "createdAt", 0 AS "taskCount"
  `;
  if (!label) {
    return Response.json({ error: 'A label with that name already exists' }, { status: 409 });
  }
  return Response.json({ label }, { status: 201 });
}

/**
 * PATCH /task-labels — { id, name?, color? }. A rename rewrites the name
 * inside every task's labels array in the same transaction, so a task
 * never carries a name that no longer has a row. The explicit "name in
 * use" check is what keeps array_replace from ever producing a duplicate
 * inside one array.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function updateTaskLabel(sql, userId, body) {
  const id = validId(body?.id) ? String(body.id) : null;
  if (!id) return Response.json({ error: 'A valid label id is required' }, { status: 400 });
  const hasName = Object.hasOwn(body, 'name');
  const hasColor = Object.hasOwn(body, 'color');
  if (!hasName && !hasColor) {
    return Response.json({ error: 'At least one change is required' }, { status: 400 });
  }
  const name = hasName ? cleanLabelName(body.name) : null;
  if (hasName && !name) return Response.json({ error: BAD_NAME }, { status: 400 });
  const color = hasColor ? cleanColor(body.color) : null;
  if (hasColor && !color) return Response.json({ error: BAD_COLOR }, { status: 400 });

  return sql.begin(async (tx) => {
    const [existing] = await tx`
      SELECT id, name FROM task_labels WHERE id = ${id} AND user_id = ${userId} FOR UPDATE
    `;
    if (!existing) return Response.json({ error: 'Label not found' }, { status: 404 });

    const renames = hasName && name !== existing.name;
    if (renames) {
      const taken = await tx`
        SELECT id FROM task_labels WHERE user_id = ${userId} AND name = ${name}
      `;
      if (taken.length) {
        return Response.json({ error: 'A label with that name already exists' }, { status: 409 });
      }
    }

    const [label] = await tx`
      UPDATE task_labels SET
        name  = CASE WHEN ${renames}::boolean THEN ${name} ELSE name END,
        color = CASE WHEN ${hasColor}::boolean THEN ${color} ELSE color END
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id, name, color, created_at AS "createdAt"
    `;
    if (renames) {
      await tx`
        UPDATE task_items
        SET labels = array_replace(labels, ${existing.name}, ${name}), updated_at = now()
        WHERE user_id = ${userId} AND labels @> ARRAY[${existing.name}]::text[]
      `;
    }
    return Response.json({ label });
  });
}

/**
 * DELETE /task-labels — { id }. The name leaves every task that carried it
 * in the same transaction.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function deleteTaskLabel(sql, userId, body) {
  const id = validId(body?.id) ? String(body.id) : null;
  if (!id) return Response.json({ error: 'A valid label id is required' }, { status: 400 });

  return sql.begin(async (tx) => {
    const deleted = await tx`
      DELETE FROM task_labels WHERE id = ${id} AND user_id = ${userId} RETURNING name
    `;
    if (!deleted.length) return Response.json({ error: 'Label not found' }, { status: 404 });
    await tx`
      UPDATE task_items
      SET labels = array_remove(labels, ${deleted[0].name}), updated_at = now()
      WHERE user_id = ${userId} AND labels @> ARRAY[${deleted[0].name}]::text[]
    `;
    return Response.json({ ok: true });
  });
}
