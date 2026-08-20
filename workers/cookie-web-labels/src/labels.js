// Ported from Cookie-Web's api/labels.js. Behaviorally identical (same
// queries, same validation, same response shapes/status codes) — only the
// (req, res) mutation style becomes returning a Response, since Workers
// speak Web-standard fetch.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_NAME = 50;
const MAX_DESCRIPTION = 200;

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function listLabels(sql, userId) {
  const labels = await sql`
    SELECT l.id, l.name, l.color, l.kind, l.description, l.auto_apply,
           count(m.id)::int AS message_count
    FROM labels l
    LEFT JOIN message_labels ml ON ml.label_id = l.id
    LEFT JOIN messages m ON m.id = ml.message_id AND NOT m.is_deleted
    WHERE l.user_id = ${userId}
    GROUP BY l.id
    ORDER BY l.name
  `;
  return Response.json({ labels });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function createLabel(sql, userId, body) {
  const name = String(body?.name ?? '').trim();
  const color = String(body?.color ?? '').trim();
  const description = String(body?.description ?? '').trim() || null;
  if (
    !name || name.length > MAX_NAME ||
    !COLOR_RE.test(color) ||
    (description && description.length > MAX_DESCRIPTION)
  ) {
    return Response.json({ error: 'name (max 50) and hex color are required' }, { status: 400 });
  }

  const [label] = await sql`
    INSERT INTO labels (user_id, name, color, description)
    VALUES (${userId}, ${name}, ${color}, ${description})
    ON CONFLICT (user_id, name) DO NOTHING
    RETURNING id, name, color, kind, description, auto_apply, 0 AS message_count
  `;
  if (!label) {
    return Response.json({ error: 'A label with that name already exists' }, { status: 409 });
  }
  return Response.json({ label }, { status: 201 });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function updateLabel(sql, userId, body) {
  const id = UUID_RE.test(body?.id) ? String(body.id) : null;
  const hasName = Object.hasOwn(body ?? {}, 'name');
  const hasColor = Object.hasOwn(body ?? {}, 'color');
  const hasDescription = Object.hasOwn(body ?? {}, 'description');
  const hasAutoApply = Object.hasOwn(body ?? {}, 'auto_apply');
  const name = String(body?.name ?? '').trim();
  const color = String(body?.color ?? '').trim();
  const description = String(body?.description ?? '').trim() || null;

  if (
    !id ||
    (!hasName && !hasColor && !hasDescription && !hasAutoApply) ||
    (hasName && (!name || name.length > MAX_NAME)) ||
    (hasColor && !COLOR_RE.test(color)) ||
    (hasDescription && description && description.length > MAX_DESCRIPTION) ||
    (hasAutoApply && body.auto_apply !== true && body.auto_apply !== false)
  ) {
    return Response.json({ error: 'id and a valid label update are required' }, { status: 400 });
  }

  let label;
  try {
    [label] = await sql`
      UPDATE labels l
      SET name = COALESCE(${hasName ? name : null}, l.name),
          color = CASE WHEN ${hasColor} THEN ${color} ELSE l.color END,
          description = CASE WHEN ${hasDescription} THEN ${description} ELSE l.description END,
          auto_apply = COALESCE(${hasAutoApply ? body.auto_apply : null}::boolean, l.auto_apply)
      WHERE l.id = ${id} AND l.user_id = ${userId}
        AND l.kind = 'user'
      RETURNING l.id, l.name, l.color, l.kind, l.description, l.auto_apply
    `;
  } catch (error) {
    if (hasName && /** @type {{code?: string}} */ (error)?.code === '23505') {
      return Response.json({ error: 'A label with that name already exists' }, { status: 409 });
    }
    throw error;
  }

  if (!label) {
    return Response.json({ error: 'User label not found' }, { status: 404 });
  }
  return Response.json({ label });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function deleteLabel(sql, userId, body) {
  const id = UUID_RE.test(body?.id) ? String(body.id) : null;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }
  const rows = await sql`
    DELETE FROM labels l
    WHERE l.id = ${id} AND l.user_id = ${userId}
      AND l.kind = 'user'
    RETURNING l.id
  `;
  if (rows.length === 0) {
    return Response.json({ error: 'User label not found' }, { status: 404 });
  }
  return Response.json({ ok: true });
}
