import { decodeCursor, encodeCursor, validId } from '../../../shared/pagination.js';
import { isCursorTime } from './taskComments.js';

const PAGE_SIZE = 50;

/**
 * GET /task-activity?task=<id>&completed=true&after=<cursor>.
 * Omitting task lists all of the caller's history, including deleted tasks.
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 */
export async function getTaskActivity(sql, userId, url) {
  const task = url.searchParams.get('task');
  if (task !== null && !validId(task))
    return Response.json({ error: 'Invalid task id' }, { status: 400 });
  const completed = url.searchParams.get('completed');
  if (completed !== null && completed !== 'true')
    return Response.json({ error: 'completed must be true' }, { status: 400 });
  let cursor;
  try {
    cursor = decodeCursor(
      url.searchParams.get('after'),
      (value) =>
        Array.isArray(value) && value.length === 2 && isCursorTime(value[0]) && validId(value[1]),
    );
  } catch {
    return Response.json({ error: 'Invalid activity cursor' }, { status: 400 });
  }
  const rows = await sql`
    SELECT a.id, a.task_id AS "taskId", a.task_title AS title, a.action, a.changes,
      a.occurred_at AS "occurredAt", (t.id IS NOT NULL) AS "taskExists",
      to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM task_activity a
    LEFT JOIN task_items t ON t.id = a.task_id AND t.user_id = ${userId}
    WHERE a.user_id = ${userId} AND (${task === null}::boolean OR a.task_id = ${task}::uuid)
      AND (${completed === null}::boolean OR a.action = 'completed')
      AND (${cursor === null}::boolean OR (a.occurred_at, a.id) <
        (${cursor?.[0] ?? null}::text::timestamptz, ${cursor?.[1] ?? null}::uuid))
    ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${PAGE_SIZE + 1}
  `;
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return Response.json({
    activities: page.map(({ cursor_time: _cursor, ...row }) => row),
    nextCursor: rows.length > PAGE_SIZE && last ? encodeCursor([last.cursor_time, last.id]) : null,
  });
}

/**
 * Calendar boundaries are evaluated by Postgres in the caller's IANA zone,
 * including DST. Counts are completion events, including recurring occurrences.
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 */
export async function getTaskProgress(sql, userId, url) {
  const timeZone = url.searchParams.get('timeZone') || 'UTC';
  if (timeZone.length > 100) return Response.json({ error: 'Invalid time zone' }, { status: 400 });
  const [zone] = await sql`SELECT name FROM pg_timezone_names WHERE name = ${timeZone}`;
  if (!zone) return Response.json({ error: 'Invalid time zone' }, { status: 400 });
  const [summary] = await sql`
    WITH bounds AS (
      SELECT date_trunc('day', now() AT TIME ZONE ${timeZone}) AS day,
        date_trunc('week', now() AT TIME ZONE ${timeZone}) AS week
    )
    SELECT count(*) FILTER (WHERE a.occurred_at >= (b.day AT TIME ZONE ${timeZone}))::integer AS daily,
      count(a.id)::integer AS weekly
    FROM bounds b LEFT JOIN task_activity a ON a.user_id = ${userId} AND a.action = 'completed'
      AND a.occurred_at >= (b.week AT TIME ZONE ${timeZone}) AND a.occurred_at <= now()
  `;
  const [goals] =
    await sql`SELECT daily, weekly FROM task_completion_goals WHERE user_id = ${userId}`;
  return Response.json({ summary, goals: goals ?? { daily: 0, weekly: 0 }, timeZone });
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {any} body
 */
export async function putTaskGoals(sql, userId, body) {
  if (!body || ![body.daily, body.weekly].every((n) => Number.isInteger(n) && n >= 0 && n <= 10000))
    return Response.json(
      { error: 'Goals must be whole numbers from 0 to 10000 (0 disables a goal)' },
      { status: 400 },
    );
  const [goals] = await sql`
    INSERT INTO task_completion_goals (user_id, daily, weekly) VALUES (${userId}, ${body.daily}, ${body.weekly})
    ON CONFLICT (user_id) DO UPDATE SET daily = EXCLUDED.daily, weekly = EXCLUDED.weekly
    RETURNING daily, weekly
  `;
  return Response.json({ goals });
}
