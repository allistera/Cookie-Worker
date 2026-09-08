const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_NAME = 50;
const MAX_DESCRIPTION = 200;

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 */
export async function listCategories(sql, userId) {
  const categories = await sql`
    SELECT c.id, c.name, c.color, c.description,
           count(m.id)::int AS message_count
    FROM email_categories c
    LEFT JOIN messages m ON m.category_id = c.id AND NOT m.is_deleted
    WHERE c.user_id = ${userId}
    GROUP BY c.id
    ORDER BY c.name
  `;
  return Response.json({ categories });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function createCategory(sql, userId, body) {
  const name = String(body?.name ?? '').trim();
  const color = String(body?.color ?? '').trim();
  const description = String(body?.description ?? '').trim() || null;
  if (
    !name ||
    name.length > MAX_NAME ||
    !COLOR_RE.test(color) ||
    (description && description.length > MAX_DESCRIPTION)
  ) {
    return Response.json({ error: 'name (max 50) and hex color are required' }, { status: 400 });
  }

  const [category] = await sql`
    INSERT INTO email_categories (user_id, name, color, description)
    VALUES (${userId}, ${name}, ${color}, ${description})
    ON CONFLICT (user_id, name) DO NOTHING
    RETURNING id, name, color, description, 0 AS message_count
  `;
  if (!category) {
    return Response.json({ error: 'A category with that name already exists' }, { status: 409 });
  }
  return Response.json({ category }, { status: 201 });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function updateCategory(sql, userId, body) {
  const id = UUID_RE.test(body?.id) ? String(body.id) : null;
  const hasName = Object.hasOwn(body ?? {}, 'name');
  const hasColor = Object.hasOwn(body ?? {}, 'color');
  const hasDescription = Object.hasOwn(body ?? {}, 'description');
  const name = String(body?.name ?? '').trim();
  const color = String(body?.color ?? '').trim();
  const description = String(body?.description ?? '').trim() || null;

  if (
    !id ||
    (!hasName && !hasColor && !hasDescription) ||
    (hasName && (!name || name.length > MAX_NAME)) ||
    (hasColor && !COLOR_RE.test(color)) ||
    (hasDescription && description && description.length > MAX_DESCRIPTION)
  ) {
    return Response.json({ error: 'id and a valid category update are required' }, { status: 400 });
  }

  let category;
  try {
    [category] = await sql`
      UPDATE email_categories c
      SET name = COALESCE(${hasName ? name : null}, c.name),
          color = CASE WHEN ${hasColor} THEN ${color} ELSE c.color END,
          description = CASE WHEN ${hasDescription} THEN ${description} ELSE c.description END
      WHERE c.id = ${id} AND c.user_id = ${userId}
      RETURNING c.id, c.name, c.color, c.description
    `;
  } catch (error) {
    if (hasName && /** @type {{code?: string}} */ (error)?.code === '23505') {
      return Response.json({ error: 'A category with that name already exists' }, { status: 409 });
    }
    throw error;
  }

  if (!category) {
    return Response.json({ error: 'Category not found' }, { status: 404 });
  }
  return Response.json({ category });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function deleteCategory(sql, userId, body) {
  const id = UUID_RE.test(body?.id) ? String(body.id) : null;
  if (!id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }
  const rows = await sql`
    DELETE FROM email_categories c
    WHERE c.id = ${id} AND c.user_id = ${userId}
    RETURNING c.id
  `;
  if (rows.length === 0) {
    return Response.json({ error: 'Category not found' }, { status: 404 });
  }
  return Response.json({ ok: true });
}
