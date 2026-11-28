import { describe, expect, test, vi } from 'vitest';
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  listRuns,
  runAutomationNow,
  updateAutomation,
} from '../src/automations.js';
import { createMockSql, createTasksService } from './helpers.js';

const NOW = new Date('2026-11-28T15:00:00Z');
const ID = '11111111-1111-4111-8111-111111111111';
const TRIGGER = {
  type: 'schedule',
  time: '00:00',
  days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
  timeZone: 'Europe/London',
};
const NEXT_MIDNIGHT = new Date('2026-11-29T00:00:00Z');

describe('listAutomations', () => {
  test('answers with the caller’s own automations, uncached', async () => {
    const rows = [{ id: ID, name: 'Reschedule Overdue Tasks to Today' }];
    const sql = createMockSql([rows]);

    const response = await listAutomations(sql, 'user-1');

    expect(await response.json()).toEqual({ automations: rows });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(sql.calls[0].values).toEqual(['user-1']);
  });
});

describe('createAutomation', () => {
  test('stores a built-in automation under its own name with its first run time', async () => {
    const sql = createMockSql([[{ count: 0 }], [{ id: ID }]]);

    const response = await createAutomation(
      sql,
      'user-1',
      { handler: 'reschedule_overdue', trigger: TRIGGER },
      NOW,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ automation: { id: ID } });
    expect(sql.calls[1].values).toEqual([
      'user-1',
      'Reschedule Overdue Tasks to Today',
      'reschedule_overdue',
      TRIGGER,
      NEXT_MIDNIGHT,
    ]);
  });

  test('keeps a name the person gave it', async () => {
    const sql = createMockSql([[{ count: 0 }], [{ id: ID }]]);

    await createAutomation(
      sql,
      'user-1',
      { handler: 'reschedule_overdue', trigger: TRIGGER, name: '  Clean slate  ' },
      NOW,
    );

    expect(sql.calls[1].values[1]).toBe('Clean slate');
  });

  test.each([
    ['an unknown job', { handler: 'send_everything', trigger: TRIGGER }],
    ['an inherited property name as the job', { handler: 'toString', trigger: TRIGGER }],
    [
      'a schedule with no days',
      { handler: 'reschedule_overdue', trigger: { ...TRIGGER, days: [] } },
    ],
    ['a blank name', { handler: 'reschedule_overdue', trigger: TRIGGER, name: '   ' }],
  ])('refuses %s before touching the database', async (_label, body) => {
    const sql = createMockSql();

    const response = await createAutomation(sql, 'user-1', body, NOW);

    expect(response.status).toBe(400);
    expect(sql.calls).toEqual([]);
  });

  test('refuses another automation once the account has its limit', async () => {
    const sql = createMockSql([[{ count: 20 }]]);

    const response = await createAutomation(
      sql,
      'user-1',
      { handler: 'reschedule_overdue', trigger: TRIGGER },
      NOW,
    );

    expect(response.status).toBe(409);
    expect(sql.calls).toHaveLength(1);
  });
});

describe('updateAutomation', () => {
  test('switching one off clears its next run', async () => {
    const sql = createMockSql([
      [{ trigger: TRIGGER, enabled: true }],
      [{ id: ID, enabled: false }],
    ]);

    const response = await updateAutomation(sql, 'user-1', { id: ID, enabled: false }, NOW);

    expect(await response.json()).toEqual({ automation: { id: ID, enabled: false } });
    expect(sql.calls[1].values).toEqual([false, '', TRIGGER, false, null, ID, 'user-1']);
  });

  test('switching one back on schedules it from now, not from when it was switched off', async () => {
    const sql = createMockSql([[{ trigger: TRIGGER, enabled: false }], [{ id: ID }]]);

    await updateAutomation(sql, 'user-1', { id: ID, enabled: true }, NOW);

    expect(sql.calls[1].values).toEqual([false, '', TRIGGER, true, NEXT_MIDNIGHT, ID, 'user-1']);
  });

  test('a new time moves the next run and leaves a switched-off automation off', async () => {
    const evening = { ...TRIGGER, time: '18:00' };
    const on = createMockSql([[{ trigger: TRIGGER, enabled: true }], [{ id: ID }]]);
    await updateAutomation(on, 'user-1', { id: ID, trigger: evening }, NOW);
    expect(on.calls[1].values.slice(2, 5)).toEqual([
      evening,
      true,
      new Date('2026-11-28T18:00:00Z'),
    ]);

    const off = createMockSql([[{ trigger: TRIGGER, enabled: false }], [{ id: ID }]]);
    await updateAutomation(off, 'user-1', { id: ID, trigger: evening }, NOW);
    expect(off.calls[1].values.slice(2, 5)).toEqual([evening, false, null]);
  });

  test('renames without touching the schedule', async () => {
    const sql = createMockSql([[{ trigger: TRIGGER, enabled: true }], [{ id: ID }]]);

    await updateAutomation(sql, 'user-1', { id: ID, name: ' Clean slate ' }, NOW);

    expect(sql.calls[1].values.slice(0, 3)).toEqual([true, 'Clean slate', TRIGGER]);
  });

  test.each([
    ['no id', { enabled: false }],
    ['a malformed id', { id: 'automation-1', enabled: false }],
    ['no change', { id: ID }],
    ['a blank name', { id: ID, name: '' }],
    ['enabled that is not a boolean', { id: ID, enabled: 'yes' }],
  ])('refuses %s before touching the database', async (_label, body) => {
    const sql = createMockSql();

    const response = await updateAutomation(sql, 'user-1', body, NOW);

    expect(response.status).toBe(400);
    expect(sql.calls).toEqual([]);
  });

  test('refuses a bad schedule without writing', async () => {
    const sql = createMockSql([[{ trigger: TRIGGER, enabled: true }]]);

    const response = await updateAutomation(
      sql,
      'user-1',
      { id: ID, trigger: { ...TRIGGER, time: 'noon' } },
      NOW,
    );

    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(1);
  });

  test('answers 404 for an automation that is not the caller’s', async () => {
    const sql = createMockSql([[]]);

    const response = await updateAutomation(sql, 'user-2', { id: ID, enabled: false }, NOW);

    expect(response.status).toBe(404);
    expect(sql.calls[0].values).toEqual([ID, 'user-2']);
  });
});

describe('deleteAutomation', () => {
  test('deletes the caller’s automation', async () => {
    const sql = createMockSql([[{ id: ID }]]);

    const response = await deleteAutomation(sql, 'user-1', { id: ID });

    expect(response.status).toBe(204);
    expect(sql.calls[0].values).toEqual([ID, 'user-1']);
  });

  test('answers 404 when there is nothing of the caller’s to delete', async () => {
    const response = await deleteAutomation(createMockSql([[]]), 'user-2', { id: ID });
    expect(response.status).toBe(404);
  });
});

describe('runAutomationNow', () => {
  test('runs the automation, records it as a manual run and answers with the outcome', async () => {
    const sql = createMockSql([
      [
        {
          id: ID,
          name: 'Clean slate',
          userId: 'user-1',
          email: 'owner@example.com',
          handler: 'reschedule_overdue',
          trigger: TRIGGER,
        },
      ],
      [{ id: 'run-1', startedAt: '2026-11-28T15:00:00.000Z' }],
      [{ id: 'task-1', mirrored: false }],
      [],
    ]);
    const tasks = createTasksService();

    const response = await runAutomationNow(
      sql,
      'user-1',
      { id: ID },
      { TASKS: tasks },
      NOW,
      vi.fn(),
    );

    expect(await response.json()).toEqual({
      run: {
        id: 'run-1',
        automationId: ID,
        automationName: 'Clean slate',
        trigger: 'manual',
        startedAt: '2026-11-28T15:00:00.000Z',
        status: 'succeeded',
        summary: 'Moved 1 overdue task to today.',
      },
    });
    expect(sql.calls[1].text).toContain("'manual'");
    expect(tasks.calls[0].identity).toEqual({ userId: 'user-1', email: 'owner@example.com' });
  });

  test('answers 404, and runs nothing, for an automation that is not the caller’s', async () => {
    const sql = createMockSql([[]]);
    const tasks = createTasksService();

    const response = await runAutomationNow(
      sql,
      'user-2',
      { id: ID },
      { TASKS: tasks },
      NOW,
      vi.fn(),
    );

    expect(response.status).toBe(404);
    expect(sql.calls).toHaveLength(1);
    expect(tasks.calls).toEqual([]);
  });
});

describe('listRuns', () => {
  test('answers with the caller’s latest runs, uncached', async () => {
    const rows = [{ id: 'run-1', automationName: 'Clean slate', status: 'succeeded' }];
    const sql = createMockSql([rows]);

    const response = await listRuns(sql, 'user-1');

    expect(await response.json()).toEqual({ runs: rows });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(sql.calls[0].values).toEqual(['user-1', 30]);
  });
});
