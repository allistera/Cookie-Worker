import { readFile } from 'node:fs/promises';
import process from 'node:process';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TASK_ACTIVITY_TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl)
  throw new Error('CI must provide the task activity test database');
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/cookie_task_activity_test'
  )
    throw new Error(
      'Task activity tests require the isolated localhost cookie_task_activity_test database',
    );
}
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe.skipIf(!databaseUrl)('0097 task activity on PostgreSQL', () => {
  let sql;
  let backfill;
  beforeAll(async () => {
    sql = postgres(databaseUrl, { max: 1 });
    await sql.unsafe(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE public.users (id uuid PRIMARY KEY);
      CREATE TABLE public.task_projects (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE public.task_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id uuid REFERENCES task_projects(id) ON DELETE CASCADE,
        parent_id uuid REFERENCES task_items(id) ON DELETE CASCADE,
        kind text NOT NULL DEFAULT 'task', content text NOT NULL, description text,
        due_date date, due_time time, time_zone text, labels text[] DEFAULT '{}',
        priority smallint DEFAULT 4, recurrence text, position double precision, today_position double precision,
        completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), search_indexed_at timestamptz
      );
    `);
    await sql`INSERT INTO users VALUES (${USER})`;
    await sql`INSERT INTO task_items (user_id, content, created_at, completed_at)
      VALUES (${USER}, 'Earlier task', '2026-01-01T10:00:00Z', '2026-01-02T10:00:00Z')`;
    const migration = await readFile(new URL('../0097_task_activity.sql', import.meta.url), 'utf8');
    await sql.begin((tx) => tx.unsafe(migration.replace(/^(BEGIN|COMMIT);[ \t]*$/gm, '')));
    const durationMigration = await readFile(
      new URL('../0098_task_duration.sql', import.meta.url),
      'utf8',
    );
    await sql.begin((tx) => tx.unsafe(durationMigration.replace(/^(BEGIN|COMMIT);[ \t]*$/gm, '')));
    const positionMigration = await readFile(
      new URL('../0117_task_activity_ignore_position.sql', import.meta.url),
      'utf8',
    );
    await sql.begin((tx) => tx.unsafe(positionMigration.replace(/^(BEGIN|COMMIT);[ \t]*$/gm, '')));
    backfill = await sql`SELECT action, occurred_at FROM task_activity ORDER BY occurred_at`;
  });
  beforeEach(async () => {
    await sql`TRUNCATE users CASCADE`;
    await sql`INSERT INTO users VALUES (${USER}), (${OTHER})`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  async function task(extra = {}) {
    const [row] =
      await sql`INSERT INTO task_items ${sql({ user_id: USER, content: 'Write notes', ...extra })} RETURNING id`;
    return row.id;
  }
  async function actions(id) {
    return sql`SELECT action, changes FROM task_activity WHERE task_id = ${id} ORDER BY occurred_at, id`;
  }

  it('stores estimates independently of dates and records changes and clearing', async () => {
    const id = await task({ duration_minutes: 45 });
    await sql`UPDATE task_items SET duration_minutes = 90 WHERE id = ${id}`;
    await sql`UPDATE task_items SET content = 'New title' WHERE id = ${id}`;
    const [row] = await sql`SELECT duration_minutes FROM task_items WHERE id = ${id}`;
    expect(row.duration_minutes).toBe(90);
    await sql`UPDATE task_items SET duration_minutes = NULL WHERE id = ${id}`;
    const history = await actions(id);
    expect(history[1].changes.duration_minutes).toEqual({ before: 45, after: 90 });
    expect(history[3].changes.duration_minutes).toEqual({ before: 90, after: null });
  });

  it.each([0, -1, 1441])('rejects an out-of-range estimate %s', async (duration) => {
    await expect(task({ duration_minutes: duration })).rejects.toThrow('violates check constraint');
  });

  it('rejects estimates on dividers', async () => {
    await expect(task({ kind: 'divider', duration_minutes: 30 })).rejects.toThrow(
      'violates check constraint',
    );
  });

  it('backfills only known creation and completion timestamps', () => {
    expect(backfill.map((row) => [row.action, row.occurred_at.toISOString()])).toEqual([
      ['created', '2026-01-01T10:00:00.000Z'],
      ['completed', '2026-01-02T10:00:00.000Z'],
    ]);
  });

  it('records edits, completion, reopening and deletion atomically without losing history', async () => {
    const id = await task();
    await sql`UPDATE task_items SET content = 'Ship notes', description = 'Reviewed' WHERE id = ${id}`;
    await sql`UPDATE task_items SET completed_at = now() WHERE id = ${id}`;
    await sql`UPDATE task_items SET completed_at = now(), updated_at = now() WHERE id = ${id}`;
    await sql`UPDATE task_items SET completed_at = NULL WHERE id = ${id}`;
    await sql`DELETE FROM task_items WHERE id = ${id}`;
    const history = await actions(id);
    expect(history.map((row) => row.action)).toEqual([
      'created',
      'edited',
      'completed',
      'reopened',
      'deleted',
    ]);
    expect(history[1].changes.content).toEqual({ before: 'Write notes', after: 'Ship notes' });
    expect(history[1].changes.description).toEqual({ before: null, after: 'Reviewed' });
  });

  it('ignores no-op writes, search indexing and dividers', async () => {
    const id = await task();
    await task({ kind: 'divider' });
    await sql`UPDATE task_items SET content = content, updated_at = now(), search_indexed_at = now()`;
    expect(await actions(id)).toHaveLength(1);
    expect(await sql`SELECT id FROM task_activity`).toHaveLength(1);
  });

  it('records no event for reordering, and leaves position out of other edits', async () => {
    const id = await task({ position: 1 });
    await sql`UPDATE task_items SET position = 2, today_position = 5 WHERE id = ${id}`;
    await sql`UPDATE task_items SET position = 3, content = 'Moved and renamed' WHERE id = ${id}`;
    const history = await actions(id);
    expect(history.map((row) => row.action)).toEqual(['created', 'edited']);
    expect(Object.keys(history[1].changes)).toEqual(['content']);
  });

  it('records each recurring occurrence without marking the next occurrence complete', async () => {
    const id = await task({ recurrence: 'every day', due_date: '2026-10-16' });
    await sql`UPDATE task_items SET due_date = '2026-10-17', last_occurrence_completed_at = clock_timestamp() WHERE id = ${id}`;
    await sql`UPDATE task_items SET due_date = '2026-10-18', last_occurrence_completed_at = clock_timestamp() WHERE id = ${id}`;
    expect((await actions(id)).filter((row) => row.action === 'completed')).toHaveLength(2);
    const [row] = await sql`SELECT completed_at FROM task_items WHERE id = ${id}`;
    expect(row.completed_at).toBeNull();
  });

  it('uses the changed occurrence stamp even when a prior completed stamp remains', async () => {
    const id = await task({ completed_at: '2026-10-15T10:00:00Z' });
    await sql`UPDATE task_items SET last_occurrence_completed_at = '2026-10-16T10:00:00Z' WHERE id = ${id}`;
    const rows =
      await sql`SELECT occurred_at FROM task_activity WHERE task_id = ${id} AND action = 'completed' ORDER BY occurred_at`;
    expect(rows.map((row) => row.occurred_at.toISOString())).toEqual([
      '2026-10-15T10:00:00.000Z',
      '2026-10-16T10:00:00.000Z',
    ]);
  });

  it('retains parent and child deletion events, but erases everything on account deletion', async () => {
    const parent = await task();
    const child = await task({ parent_id: parent });
    await sql`DELETE FROM task_items WHERE id = ${parent}`;
    expect((await actions(child)).map((row) => row.action)).toEqual(['created', 'deleted']);
    await task();
    await sql`DELETE FROM users WHERE id = ${USER}`;
    expect(await sql`SELECT id FROM task_activity`).toHaveLength(0);
  });

  it('rolls back events together with a failed task transaction', async () => {
    const id = await task();
    await expect(
      sql.begin(async (tx) => {
        await tx`UPDATE task_items SET completed_at = now() WHERE id = ${id}`;
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await actions(id)).map((row) => row.action)).toEqual(['created']);
  });

  it('keeps history and goals server-only and enforces goal bounds', async () => {
    const rows =
      await sql`SELECT relrowsecurity FROM pg_class WHERE oid IN ('task_activity'::regclass, 'task_completion_goals'::regclass)`;
    expect(rows.every((row) => row.relrowsecurity)).toBe(true);
    const [access] =
      await sql`SELECT has_table_privilege('anon', 'task_activity', 'SELECT') AS anon,
      has_table_privilege('authenticated', 'task_completion_goals', 'UPDATE') AS authenticated`;
    expect(access).toEqual({ anon: false, authenticated: false });
    await expect(
      sql`INSERT INTO task_completion_goals (user_id, daily) VALUES (${USER}, -1)`,
    ).rejects.toThrow(/check constraint/);
  });
});
