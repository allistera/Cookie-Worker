// Ported from Cookie-Web's api/_lib/rate-limit.js. Atomically claims a
// fixed-window quota in Postgres. Keeping the counter in the shared database
// makes the limit effective across isolates, colos, and whatever still runs
// on Vercel — the 'ai' scope, for instance, is shared by cookie-web-ai's
// compose/summarize routes and Cookie-Web's remaining ask/search functions.

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} scope
 * @param {{limit: number, windowMs: number}} policy
 */
export async function allowRequest(sql, userId, scope, { limit, windowMs }) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
    throw new Error('Invalid rate-limit policy');
  }

  const [result] = await sql`
    WITH claimed AS (
      INSERT INTO api_rate_limits (user_id, scope, window_start, request_count)
      VALUES (${userId}, ${scope}, now(), 1)
      ON CONFLICT (user_id, scope) DO UPDATE SET
        window_start = CASE
          WHEN api_rate_limits.window_start <= now() - (${windowMs} * interval '1 millisecond')
            THEN EXCLUDED.window_start
          ELSE api_rate_limits.window_start
        END,
        request_count = CASE
          WHEN api_rate_limits.window_start <= now() - (${windowMs} * interval '1 millisecond')
            THEN 1
          ELSE api_rate_limits.request_count + 1
        END,
        updated_at = now()
      WHERE api_rate_limits.window_start <= now() - (${windowMs} * interval '1 millisecond')
         OR api_rate_limits.request_count < ${limit}
      RETURNING user_id
    )
    SELECT EXISTS (SELECT 1 FROM claimed) AS allowed
  `;
  return result?.allowed === true;
}
