import { decodeCursor, encodeCursor, validId, validTimestamp } from '../../../shared/pagination.js';

function columns(sql, full = false) {
  return sql`t.id, t.kind, t.project_id AS "projectId", t.parent_id AS "parentId", t.content,
    ${full ? sql`t.description` : sql`left(t.description, 240)`} AS description,
    t.recurrence, to_char(t.due_time, 'HH24:MI') AS "dueTime", t.time_zone AS "timeZone",
    t.labels, to_char(t.due_date, 'YYYY-MM-DD') AS "dueDate", t.priority, t.position,
    t.today_position AS "todayPosition", t.completed_at AS "completedAt", t.created_at AS "createdAt",
    to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time`;
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {URL} url */
export async function getTaskPage(sql, userId, url) {
  const project = url.searchParams.get('project') ?? 'inbox';
  const today = project === 'today';
  const date = url.searchParams.get('date');
  if (!['today', 'inbox'].includes(project) && !validId(project))
    return Response.json({ error: 'Invalid project' }, { status: 400 });
  if (
    today &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ||
      !validTimestamp(date) ||
      new Date(date ?? '').toISOString().slice(0, 10) !== date)
  )
    return Response.json({ error: 'Invalid date' }, { status: 400 });
  let cursor;
  try {
    cursor = decodeCursor(
      url.searchParams.get('after'),
      (value) =>
        Array.isArray(value) &&
        value.length === 5 &&
        validTimestamp(value[0]) &&
        (value[1] === null || Number.isFinite(value[1])) &&
        Number.isFinite(value[2]) &&
        validTimestamp(value[3]) &&
        validId(value[4]),
    );
  } catch {
    return Response.json({ error: 'Invalid task cursor' }, { status: 400 });
  }
  const orderDate = today ? sql`t.due_date` : sql`DATE '0001-01-01'`;
  const orderPosition = today
    ? sql`COALESCE(t.today_position, 'Infinity'::float8)`
    : sql`0::float8`;
  const rows = await sql`SELECT ${columns(sql)} FROM task_items t
    WHERE t.user_id = ${userId} AND t.parent_id IS NULL
      ${url.searchParams.get('completed') === '1' ? sql`` : sql`AND t.completed_at IS NULL`}
      ${
        today
          ? sql`AND t.due_date <= ${date}::date`
          : project === 'inbox'
            ? sql`AND t.project_id IS NULL`
            : sql`AND t.project_id = ${project}::uuid`
      }
      ${
        cursor
          ? sql`AND (${orderDate}, ${orderPosition}, t.position, t.created_at, t.id) >
        (${cursor[0]}::date, ${cursor[1] ?? 'Infinity'}::float8, ${cursor[2]}::float8, ${cursor[3]}::text::timestamptz, ${cursor[4]}::uuid)`
          : sql``
      }
    ORDER BY ${orderDate}, ${orderPosition}, t.position, t.created_at, t.id LIMIT 101`;
  const last = rows.slice(0, 100).at(-1);
  const items = rows
    .slice(0, 100)
    .map(({ cursor_time: _cursorTime, ...row }) => ({ ...row, summary: true }));
  return Response.json({
    items,
    nextCursor:
      rows.length > 100 && last
        ? encodeCursor([
            today ? last.dueDate : '0001-01-01',
            today ? last.todayPosition : 0,
            Number(last.position),
            last.cursor_time,
            last.id,
          ])
        : null,
  });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {URL} url */
export async function getTaskDetail(sql, userId, url) {
  const id = url.searchParams.get('id');
  if (!validId(id)) return Response.json({ error: 'Invalid task id' }, { status: 400 });
  let cursor;
  try {
    cursor = decodeCursor(
      url.searchParams.get('after'),
      (value) =>
        Array.isArray(value) &&
        value.length === 3 &&
        Number.isFinite(value[0]) &&
        validTimestamp(value[1]) &&
        validId(value[2]),
    );
  } catch {
    return Response.json({ error: 'Invalid subtask cursor' }, { status: 400 });
  }
  const [item] =
    await sql`SELECT ${columns(sql, true)} FROM task_items t WHERE t.user_id = ${userId} AND t.id = ${id}`;
  if (!item) return Response.json({ error: 'Task not found' }, { status: 404 });
  const rows = await sql`SELECT ${columns(sql, true)} FROM task_items t
    WHERE t.user_id = ${userId} AND t.parent_id = ${id}
      ${cursor ? sql`AND (t.position, t.created_at, t.id) > (${cursor[0]}::float8, ${cursor[1]}::text::timestamptz, ${cursor[2]}::uuid)` : sql``}
    ORDER BY t.position, t.created_at, t.id LIMIT 101`;
  const [counts] =
    await sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE completed_at IS NOT NULL)::int AS done
    FROM task_items WHERE user_id = ${userId} AND parent_id = ${id}`;
  const last = rows.slice(0, 100).at(-1);
  const subtasks = rows.slice(0, 100).map(({ cursor_time: _cursorTime, ...row }) => row);
  delete item.cursor_time;
  return Response.json({
    item: { ...item, summary: false },
    subtasks,
    counts,
    nextCursor:
      rows.length > 100 && last
        ? encodeCursor([Number(last.position), last.cursor_time, last.id])
        : null,
  });
}
