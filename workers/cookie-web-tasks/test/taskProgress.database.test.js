import process from 'node:process';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { getTaskProgress, putTaskGoals } from '../src/taskActivity.js';

const databaseUrl = process.env.SCREENING_RETENTION_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/cookie_screening_retention_test'
  )
    throw new Error('Progress tests require the disposable loopback retention database');
}
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!databaseUrl)('progress queries on PostgreSQL', () => {
  it.each(['UTC', 'Europe/London', 'America/New_York', 'Pacific/Kiritimati'])(
    'counts local days and weeks in %s, excluding other owners and future events',
    async (timeZone) => {
      const sql = postgres(/** @type {string} */ (databaseUrl), { max: 1 });
      try {
        await sql.begin(async (tx) => {
          // Connection-local tables shadow public tables and vanish on commit.
          await tx`CREATE TEMP TABLE task_activity (id uuid DEFAULT gen_random_uuid(), user_id uuid, action text, occurred_at timestamptz) ON COMMIT DROP`;
          await tx`CREATE TEMP TABLE task_completion_goals (user_id uuid PRIMARY KEY, daily integer, weekly integer) ON COMMIT DROP`;
          await tx`INSERT INTO task_activity(user_id, action, occurred_at) VALUES
          (${USER}, 'completed', now()),
          (${USER}, 'created', now()),
          (${OTHER}, 'completed', now()),
          (${USER}, 'completed', now() + interval '1 day'),
          (${USER}, 'completed', (date_trunc('day', now() AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone}) - interval '1 second'),
          (${USER}, 'completed', (date_trunc('week', now() AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone}) - interval '1 second')`;
          const [calendar] =
            await tx`SELECT extract(isodow FROM now() AT TIME ZONE ${timeZone})::integer AS weekday`;
          const url = new URL(`https://x/task-progress?${new URLSearchParams({ timeZone })}`);
          const result = await (await getTaskProgress(/** @type {any} */ (tx), USER, url)).json();
          expect(result.summary).toEqual({ daily: 1, weekly: calendar.weekday > 1 ? 2 : 1 });
          expect(result.goals).toEqual({ daily: 0, weekly: 0 });
          await putTaskGoals(/** @type {any} */ (tx), USER, { daily: 5, weekly: 25 });
          const updated = await (await getTaskProgress(/** @type {any} */ (tx), USER, url)).json();
          expect(updated.goals).toEqual({ daily: 5, weekly: 25 });
          const empty = await (
            await getTaskProgress(
              /** @type {any} */ (tx),
              '33333333-3333-4333-8333-333333333333',
              url,
            )
          ).json();
          expect(empty.summary).toEqual({ daily: 0, weekly: 0 });
          expect(empty.goals).toEqual({ daily: 0, weekly: 0 });
        });
      } finally {
        await sql.end();
      }
    },
  );
});
