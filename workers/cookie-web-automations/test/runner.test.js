import { describe, expect, test, vi } from 'vitest';
import { executeRun, runDueAutomations } from '../src/runner.js';
import { createMockSql, createTasksService } from './helpers.js';

const NOW = new Date('2026-11-28T00:00:00Z');
const TRIGGER = {
  type: 'schedule',
  time: '00:00',
  days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
  timeZone: 'Europe/London',
};
const AUTOMATION = {
  id: 'automation-1',
  userId: 'user-1',
  email: 'owner@example.com',
  handler: 'reschedule_overdue',
  trigger: TRIGGER,
};

describe('runDueAutomations', () => {
  test('claims a due automation, moves its schedule on, runs it and records the outcome', async () => {
    const sql = createMockSql([
      [], // settle unfinished runs
      [AUTOMATION], // due
      [], // move next_run_at on
      [{ id: 'run-1' }], // the run row
      [{ id: 'task-1', mirrored: false }], // the handler's overdue read
      [], // settle the run
    ]);
    const tasks = createTasksService();
    const report = vi.fn();

    await expect(runDueAutomations(sql, { TASKS: tasks }, NOW, report)).resolves.toBe(1);

    // Claimed inside one transaction, before any work is done.
    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(sql.calls[1].text).toContain('FOR UPDATE OF a SKIP LOCKED');
    expect(sql.calls[1].values[0]).toEqual(NOW);
    // The schedule moves to the next midnight, never staying due.
    expect(sql.calls[2].values).toEqual([new Date('2026-11-29T00:00:00Z'), true, 'automation-1']);
    expect(sql.calls[3].values).toEqual(['automation-1', 'user-1']);
    expect(tasks.calls).toHaveLength(1);
    expect(sql.calls[5].values).toEqual(['succeeded', 'Moved 1 overdue task to today.', 'run-1']);
    expect(report).not.toHaveBeenCalled();
  });

  test('does nothing more when no automation is due', async () => {
    const sql = createMockSql([[], []]);
    const tasks = createTasksService();

    await expect(runDueAutomations(sql, { TASKS: tasks }, NOW, vi.fn())).resolves.toBe(0);
    expect(sql.calls).toHaveLength(2);
    expect(tasks.calls).toEqual([]);
  });

  test('marks runs that never finished as failed before claiming anything', async () => {
    const sql = createMockSql([[], []]);
    await runDueAutomations(sql, { TASKS: createTasksService() }, NOW, vi.fn());

    expect(sql.calls[0].text).toContain("status = 'running'");
    expect(sql.calls[0].text).toContain("SET status = 'failed'");
  });

  test('switches off an automation whose stored schedule cannot be read, and fails its run', async () => {
    const sql = createMockSql([
      [],
      [{ ...AUTOMATION, trigger: { type: 'schedule', time: 'whenever' } }],
      [],
      [{ id: 'run-1' }],
      [],
    ]);
    const report = vi.fn();

    await runDueAutomations(sql, { TASKS: createTasksService() }, NOW, report);

    expect(sql.calls[2].values).toEqual([null, false, 'automation-1']);
    expect(sql.calls[4].values).toEqual(['failed', 'The run failed.', 'run-1']);
    expect(report).toHaveBeenCalledWith('schedule', expect.any(Error), {
      handler: 'reschedule_overdue',
    });
  });
});

describe('executeRun', () => {
  test('records a failure the person can act on in the handler’s own words', async () => {
    const sql = createMockSql([[{ id: 'task-1', mirrored: false }], []]);
    const tasks = createTasksService(() => ({ status: 500 }));
    const report = vi.fn();

    await expect(
      executeRun(sql, { TASKS: tasks }, AUTOMATION, 'run-1', NOW, report),
    ).resolves.toEqual({
      status: 'failed',
      summary: 'Moved 0 tasks to today; 1 could not be moved.',
    });
    expect(sql.calls[1].values).toEqual([
      'failed',
      'Moved 0 tasks to today; 1 could not be moved.',
      'run-1',
    ]);
    // A failure the run explains is not also an error report.
    expect(report).not.toHaveBeenCalled();
  });

  test('reports an unexpected failure and keeps its detail out of the summary', async () => {
    const sql = createMockSql([[{ id: 'task-1', mirrored: false }], []]);
    const tasks = {
      call: vi.fn(async () => {
        throw new Error('binding exploded: postgres://secret');
      }),
    };
    const report = vi.fn();

    const outcome = await executeRun(sql, { TASKS: tasks }, AUTOMATION, 'run-1', NOW, report);

    expect(outcome).toEqual({ status: 'failed', summary: 'The run failed.' });
    expect(report).toHaveBeenCalledWith('run', expect.any(Error), {
      handler: 'reschedule_overdue',
    });
  });

  test('fails a run whose job no longer exists without calling anything', async () => {
    const sql = createMockSql([[]]);
    const tasks = createTasksService();

    const outcome = await executeRun(
      sql,
      { TASKS: tasks },
      { ...AUTOMATION, handler: 'constructor' },
      'run-1',
      NOW,
      vi.fn(),
    );

    expect(outcome).toEqual({
      status: 'failed',
      summary: 'This automation is no longer available.',
    });
    expect(tasks.calls).toEqual([]);
  });
});
