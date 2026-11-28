import { describe, expect, test } from 'vitest';
import { HANDLERS, MAX_MOVES_PER_RUN, RunError } from '../src/handlers.js';
import { createMockSql, createTasksService } from './helpers.js';

const identity = { userId: 'user-1', email: 'owner@example.com' };
const NOW = new Date('2026-11-28T00:02:00Z');

/** @param {any} sql @param {any} tasks @param {string} [timeZone] */
function run(sql, tasks, timeZone = 'Europe/London') {
  return HANDLERS.reschedule_overdue.run({ sql, tasks, identity, timeZone, now: NOW });
}

describe('reschedule_overdue', () => {
  test('moves each overdue task to today through the tasks API, as the owner', async () => {
    const sql = createMockSql([
      [
        { id: 'task-1', mirrored: false },
        { id: 'task-2', mirrored: false },
      ],
    ]);
    const tasks = createTasksService();

    await expect(run(sql, tasks)).resolves.toBe('Moved 2 overdue tasks to today.');

    // Overdue means due before today where the person is.
    expect(sql.calls[0].values).toEqual(['user-1', '2026-11-28']);
    expect(tasks.calls).toEqual([
      {
        identity,
        call: {
          method: 'PATCH',
          path: '/task-items',
          body: { id: 'task-1', dueDate: '2026-11-28' },
        },
      },
      {
        identity,
        call: {
          method: 'PATCH',
          path: '/task-items',
          body: { id: 'task-2', dueDate: '2026-11-28' },
        },
      },
    ]);
  });

  test('takes today from the automation’s time zone', async () => {
    const sql = createMockSql([[{ id: 'task-1', mirrored: false }]]);
    const tasks = createTasksService();

    await run(sql, tasks, 'America/Los_Angeles');

    expect(tasks.calls[0].call.body).toEqual({ id: 'task-1', dueDate: '2026-11-27' });
  });

  test('says so when nothing was overdue', async () => {
    const tasks = createTasksService();
    await expect(run(createMockSql([[]]), tasks)).resolves.toBe('Nothing was overdue.');
    expect(tasks.calls).toEqual([]);
  });

  test('leaves tasks mirrored from Todoist alone and says how many', async () => {
    const sql = createMockSql([
      [
        { id: 'task-1', mirrored: true },
        { id: 'task-2', mirrored: false },
        { id: 'task-3', mirrored: true },
      ],
    ]);
    const tasks = createTasksService();

    await expect(run(sql, tasks)).resolves.toBe(
      'Moved 1 overdue task to today. Left 2 Todoist tasks as they are.',
    );
    expect(tasks.calls.map(({ call }) => call.body.id)).toEqual(['task-2']);
  });

  test('does not count a task deleted or changed during the run as a failure', async () => {
    const sql = createMockSql([
      [
        { id: 'gone', mirrored: false },
        { id: 'changed', mirrored: false },
        { id: 'task-3', mirrored: false },
      ],
    ]);
    const tasks = createTasksService(({ body }) => ({
      status: body.id === 'gone' ? 404 : body.id === 'changed' ? 409 : 200,
    }));

    await expect(run(sql, tasks)).resolves.toBe('Moved 1 overdue task to today.');
  });

  test('fails the run, with what it managed, when the tasks API refuses a move', async () => {
    const sql = createMockSql([
      [
        { id: 'task-1', mirrored: false },
        { id: 'task-2', mirrored: false },
      ],
    ]);
    const tasks = createTasksService(({ body }) => ({ status: body.id === 'task-2' ? 500 : 200 }));

    const failure = await run(sql, tasks).catch((error) => error);
    expect(failure).toBeInstanceOf(RunError);
    expect(failure.message).toBe('Moved 1 task to today; 1 could not be moved.');
  });

  test('moves a bounded number per run and leaves the rest for the next one', async () => {
    const overdue = Array.from({ length: MAX_MOVES_PER_RUN + 3 }, (_, index) => ({
      id: `task-${index}`,
      mirrored: false,
    }));
    const tasks = createTasksService();

    await expect(run(createMockSql([overdue]), tasks)).resolves.toBe(
      `Moved ${MAX_MOVES_PER_RUN} overdue tasks to today. 3 more tasks will move on the next run.`,
    );
    expect(tasks.calls).toHaveLength(MAX_MOVES_PER_RUN);
  });
});
