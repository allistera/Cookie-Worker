import { describe, expect, it, vi } from 'vitest';
import { TodoistApiError, TodoistAuthError } from '../src/todoistApi.js';
import {
  COMPLETED_LOOKBACK_MS,
  SECTION_PREFIX,
  applySync,
  describeSyncFailure,
  indexSyncedTasks,
  isSyncHour,
  mapDue,
  mapLabels,
  mapPriority,
  planSync,
  syncConnection,
} from '../src/todoistSync.js';
import { createMockSql } from './helpers.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const ZONE = 'Europe/London';

/** @param {unknown} body */
function jsonResponse(body) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

describe('mapPriority', () => {
  it("inverts Todoist's scale so 4 (urgent) becomes Cookie's 1", () => {
    expect(mapPriority(4)).toBe(1);
    expect(mapPriority(3)).toBe(2);
    expect(mapPriority(1)).toBe(4);
    expect(mapPriority(undefined)).toBe(4);
    expect(mapPriority(99)).toBe(1);
  });
});

describe('mapLabels', () => {
  it('normalises names the way Cookie writes them and drops what it cannot hold', () => {
    expect(mapLabels(['Home', '@Work', 'two words', 'bad#name', 'Home', 42, ''])).toEqual([
      'home',
      'work',
      'two_words',
      'badname',
    ]);
    expect(mapLabels(undefined)).toEqual([]);
    expect(mapLabels(Array.from({ length: 30 }, (_, i) => `l${i}`))).toHaveLength(20);
  });
});

describe('mapDue', () => {
  it('maps a date-only due date', () => {
    expect(mapDue({ date: '2026-10-20', string: 'Oct 20', is_recurring: false }, ZONE)).toEqual({
      dueDate: '2026-10-20',
      dueTime: null,
      timeZone: null,
      recurrence: null,
    });
  });

  it('keeps a floating time in the task zone, falling back to the account zone', () => {
    expect(mapDue({ date: '2026-10-20T14:30:00', timezone: 'Europe/Paris' }, ZONE)).toEqual({
      dueDate: '2026-10-20',
      dueTime: '14:30',
      timeZone: 'Europe/Paris',
      recurrence: null,
    });
    expect(mapDue({ date: '2026-10-20T09:05:00' }, ZONE)).toMatchObject({
      dueTime: '09:05',
      timeZone: ZONE,
    });
  });

  it('shows an instant on the day and time of the task zone', () => {
    // 23:30 UTC on the 20th is 01:30 on the 21st in Paris (CEST, UTC+2).
    expect(mapDue({ date: '2026-07-20T23:30:00Z', timezone: 'Europe/Paris' }, ZONE)).toMatchObject({
      dueDate: '2026-07-21',
      dueTime: '01:30',
      timeZone: 'Europe/Paris',
    });
    expect(mapDue({ datetime: '2026-07-20T23:30:00Z' }, 'America/New_York')).toMatchObject({
      dueDate: '2026-07-20',
      dueTime: '19:30',
      timeZone: 'America/New_York',
    });
  });

  it('keeps a repeat rule Cookie can phrase and drops one it cannot', () => {
    expect(
      mapDue({ date: '2026-10-20', string: 'every Monday', is_recurring: true }, ZONE),
    ).toMatchObject({ recurrence: 'every monday' });
    expect(
      mapDue({ date: '2026-10-20', string: 'every 3 days', is_recurring: true }, ZONE),
    ).toMatchObject({ recurrence: 'every 3 days' });
    expect(
      mapDue({ date: '2026-10-20', string: 'every workday at 9am', is_recurring: true }, ZONE),
    ).toMatchObject({ recurrence: null });
    // Not recurring: the wording is ignored even if it would parse.
    expect(
      mapDue({ date: '2026-10-20', string: 'every Monday', is_recurring: false }, ZONE),
    ).toMatchObject({ recurrence: null });
  });

  it('treats an unusable value as no due date', () => {
    expect(mapDue(null, ZONE).dueDate).toBeNull();
    expect(mapDue({ date: '2026-02-31' }, ZONE).dueDate).toBeNull();
    expect(mapDue({ date: 'soon' }, ZONE).dueDate).toBeNull();
  });
});

const SNAPSHOT = {
  projects: [
    { id: 'inbox', name: 'Inbox', inbox_project: true, child_order: 0 },
    { id: 'work', name: 'Work', parent_id: null, child_order: 2, description: 'Day job' },
    { id: 'reports', name: 'Reports', parent_id: 'work', child_order: 1 },
    { id: 'old', name: 'Old', parent_id: null, is_archived: true },
    { id: 'gone', name: 'Gone', parent_id: null, is_deleted: true },
  ],
  sections: [
    { id: 's2', name: 'Later', project_id: 'work', section_order: 2 },
    { id: 's1', name: 'Next up', project_id: 'work', section_order: 1 },
    { id: 's3', name: 'Archived', project_id: 'work', is_archived: true },
    { id: 's4', name: 'Elsewhere', project_id: 'unknown' },
    { id: 's5', name: 'Inbox section', project_id: 'inbox', section_order: 1 },
  ],
  tasks: [
    {
      id: 't1',
      content: 'Write the report',
      description: '',
      project_id: 'work',
      section_id: 's1',
      parent_id: null,
      labels: ['Work', 'Urgent'],
      priority: 4,
      child_order: 2,
      due: { date: '2026-10-20', string: 'Oct 20', is_recurring: false },
    },
    {
      id: 't1a',
      content: 'Gather numbers',
      project_id: 'work',
      section_id: 's1',
      parent_id: 't1',
      priority: 1,
      child_order: 1,
    },
    {
      id: 't2',
      content: 'Loose end',
      project_id: 'work',
      section_id: null,
      parent_id: null,
      priority: 2,
      child_order: 5,
    },
    {
      id: 't3',
      content: 'Buy milk',
      project_id: 'inbox',
      parent_id: null,
      priority: 1,
      child_order: 1,
    },
    { id: 't4', content: 'Orphan', project_id: 'unknown', parent_id: null, priority: 1 },
    { id: 't5', content: 'Done already', project_id: 'work', parent_id: null, checked: true },
    {
      id: 't6',
      content: 'Child of the void',
      project_id: 'work',
      parent_id: 'missing',
      priority: 1,
      child_order: 9,
    },
  ],
  completed: [
    { id: 'c1', completed_at: '2026-10-14T09:00:00Z' },
    { id: 'c2', completed_at: 'not a date' },
  ],
};

describe('planSync', () => {
  const plan = planSync(SNAPSHOT, { timeZone: ZONE });

  it('keeps live projects parents-first and leaves the Inbox, archived and deleted out', () => {
    expect(plan.projects.map((project) => project.todoistId)).toEqual(['work', 'reports']);
    expect(plan.projects[0]).toMatchObject({
      name: 'Work',
      parentTodoistId: null,
      description: 'Day job',
      depth: 0,
    });
    expect(plan.projects[1]).toMatchObject({ parentTodoistId: 'work', depth: 1 });
  });

  it('turns sections into dividers in Todoist order, in the Inbox too', () => {
    expect(plan.sections).toEqual([
      // Inbox: no unsectioned roots there... t3 is unsectioned, so the
      // divider follows it.
      {
        todoistId: `${SECTION_PREFIX}s5`,
        content: 'Inbox section',
        projectTodoistId: null,
        position: 2,
      },
      {
        todoistId: `${SECTION_PREFIX}s1`,
        content: 'Next up',
        projectTodoistId: 'work',
        position: 3,
      },
      { todoistId: `${SECTION_PREFIX}s2`, content: 'Later', projectTodoistId: 'work', position: 5 },
    ]);
  });

  it('orders a project as unsectioned tasks, then each section and its tasks', () => {
    const byId = new Map(plan.tasks.map((task) => [task.todoistId, task]));
    expect(byId.get('t2')).toMatchObject({ projectTodoistId: 'work', position: 1 });
    // 'Child of the void' has an unknown parent, so it is a top-level task.
    expect(byId.get('t6')).toMatchObject({ parentTodoistId: null, position: 2, depth: 0 });
    expect(byId.get('t1')).toMatchObject({ position: 4, depth: 0 });
    expect(byId.get('t3')).toMatchObject({ projectTodoistId: null, position: 1 });
  });

  it('maps task fields and places a sub-task among its siblings', () => {
    const report = plan.tasks.find((task) => task.todoistId === 't1');
    expect(report).toMatchObject({
      content: 'Write the report',
      description: null,
      labels: ['work', 'urgent'],
      priority: 1,
      dueDate: '2026-10-20',
      dueTime: null,
      timeZone: null,
      recurrence: null,
    });
    const child = plan.tasks.find((task) => task.todoistId === 't1a');
    expect(child).toMatchObject({ parentTodoistId: 't1', position: 1, depth: 1, priority: 4 });
    expect(plan.tasks.at(-1)?.todoistId).toBe('t1a');
    expect(plan.labels).toEqual(['urgent', 'work']);
  });

  it('skips tasks in unknown projects and completed tasks', () => {
    expect(plan.tasks.map((task) => task.todoistId)).not.toContain('t4');
    expect(plan.tasks.map((task) => task.todoistId)).not.toContain('t5');
    expect(plan.skipped).toBe(1);
  });

  it('keeps only completions with a readable timestamp', () => {
    expect([...plan.completed]).toEqual([['c1', '2026-10-14T09:00:00.000Z']]);
  });
});

describe('applySync', () => {
  const plan = planSync(SNAPSHOT, { timeZone: ZONE });
  const WORK = '22222222-2222-2222-2222-222222222222';
  const REPORTS = '33333333-3333-3333-3333-333333333333';
  const T1 = '44444444-4444-4444-4444-444444444444';

  it('upserts level by level, resolves parents to Cookie ids, and reconciles what vanished', async () => {
    const sql = createMockSql([
      [{ id: WORK, todoistId: 'work' }], // projects depth 0
      [{ id: REPORTS, todoistId: 'reports' }], // projects depth 1
      [{ id: 'removed-project' }], // vanished projects deleted
      [], // vanished projects unlinked
      [
        // existing mirrors
        { id: T1, todoistId: 't1', parentId: null, completedAt: null },
        { id: 'c1-row', todoistId: 'c1', parentId: null, completedAt: null },
        { id: 'z-row', todoistId: 'zombie', parentId: null, completedAt: null },
        { id: 'done-row', todoistId: 'already', parentId: null, completedAt: '2026-01-01' },
        { id: 'sec-row', todoistId: `${SECTION_PREFIX}old`, parentId: null, completedAt: null },
      ],
      [], // sections upsert
      [
        // tasks depth 0
        { id: T1, todoistId: 't1', parentId: null },
        { id: 't2-row', todoistId: 't2', parentId: null },
        { id: 't3-row', todoistId: 't3', parentId: null },
        { id: 't6-row', todoistId: 't6', parentId: null },
      ],
      [{ id: 't1a-row', todoistId: 't1a', parentId: T1 }], // tasks depth 1
      [], // parent re-index mark
      [], // completions
      [
        { id: 'z-row', kind: 'task', parentId: null },
        { id: 'sec-row', kind: 'divider', parentId: null },
      ],
      [], // registerTaskLabels
    ]);

    const { summary, deletedRootIds } = await applySync(sql, USER_ID, plan);

    const texts = sql.calls.map((/** @type {{text: string}} */ call) => call.text);
    expect(texts[0]).toContain('INSERT INTO task_projects');
    expect(sql.calls[0].values[1]).toEqual({
      __json: [{ todoist_id: 'work', name: 'Work', parent_id: null, description: 'Day job' }],
    });
    // The sub-project's parent is the Cookie id the first level returned.
    expect(sql.calls[1].values[1]).toEqual({
      __json: [{ todoist_id: 'reports', name: 'Reports', parent_id: WORK, description: null }],
    });
    expect(texts[2]).toContain('DELETE FROM task_projects');
    expect(sql.calls[2].values[1]).toEqual(['work', 'reports']);
    expect(texts[3]).toContain('SET todoist_id = NULL');
    expect(texts[4]).toContain('WHERE user_id = ? AND todoist_id IS NOT NULL');

    expect(texts[5]).toContain("'divider'");
    expect(sql.calls[5].values[1].__json).toEqual([
      {
        todoist_id: `${SECTION_PREFIX}s5`,
        content: 'Inbox section',
        project_id: null,
        position: 2,
      },
      { todoist_id: `${SECTION_PREFIX}s1`, content: 'Next up', project_id: WORK, position: 3 },
      { todoist_id: `${SECTION_PREFIX}s2`, content: 'Later', project_id: WORK, position: 5 },
    ]);

    expect(texts[6]).toContain("'task'");
    const roots = sql.calls[6].values[1].__json;
    // Inbox first, then each project in order.
    expect(roots.map((/** @type {any} */ row) => row.todoist_id)).toEqual(['t3', 't2', 't6', 't1']);
    expect(roots[0].project_id).toBeNull();
    expect(roots[3]).toEqual({
      todoist_id: 't1',
      content: 'Write the report',
      description: null,
      project_id: WORK,
      parent_id: null,
      due_date: '2026-10-20',
      due_time: null,
      time_zone: null,
      labels: ['work', 'urgent'],
      priority: 1,
      recurrence: null,
      position: 4,
    });
    expect(sql.calls[7].values[1].__json).toEqual([
      expect.objectContaining({ todoist_id: 't1a', parent_id: T1, position: 1 }),
    ]);
    expect(texts[8]).toContain('SET search_indexed_at = NULL');
    expect(sql.calls[8].values[1]).toEqual([T1]);

    // c1 vanished and was completed in Todoist; 'zombie' just vanished; the
    // already-completed mirror and the stale section are handled as before.
    expect(texts[9]).toContain('SET completed_at = r.completed_at::timestamptz');
    expect(sql.calls[9].values[0]).toEqual({
      __json: [{ todoist_id: 'c1', completed_at: '2026-10-14T09:00:00.000Z' }],
    });
    expect(texts[10]).toContain('DELETE FROM task_items');
    expect(sql.calls[10].values[1]).toEqual(['zombie', `${SECTION_PREFIX}old`]);
    expect(texts[11]).toContain('INSERT INTO task_labels');
    expect(sql.calls[11].values[1]).toEqual(['urgent', 'work']);

    expect(summary).toEqual({
      projects: 2,
      sections: 3,
      tasks: 5,
      completed: 1,
      removed: 1 + 2,
      skipped: 1,
    });
    expect(deletedRootIds).toEqual(['z-row']);
  });

  it('runs no project or task statements for an empty account beyond the reconciliation', async () => {
    const sql = createMockSql([[], [], [], []]);
    const result = await applySync(
      sql,
      USER_ID,
      planSync({ projects: [], sections: [], tasks: [], completed: [] }, { timeZone: ZONE }),
    );
    const texts = sql.calls.map((/** @type {{text: string}} */ call) => call.text);
    expect(texts.some((text) => text.includes('INSERT INTO task_items'))).toBe(false);
    expect(result.summary).toEqual({
      projects: 0,
      sections: 0,
      tasks: 0,
      completed: 0,
      removed: 0,
      skipped: 0,
    });
  });
});

describe('indexSyncedTasks', () => {
  const env = { MEILISEARCH_URL: 'https://meili.example', MEILISEARCH_API_KEY: 'k' };

  it('drops deleted roots, pushes unindexed mirrors in chunks and stamps them', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: `id-${i}`, content: `t${i}` }));
    const sql = createMockSql([rows, [], []]);
    const addDocuments = vi.fn(async () => ({}));
    const deleteDocuments = vi.fn(async () => ({}));

    await indexSyncedTasks(sql, env, USER_ID, ['gone-1'], { addDocuments, deleteDocuments });

    expect(deleteDocuments).toHaveBeenCalledWith(env, expect.anything(), ['gone-1']);
    expect(addDocuments).toHaveBeenCalledTimes(2);
    expect(/** @type {any[]} */ (addDocuments.mock.calls[0])[2]).toHaveLength(50);
    expect(sql.calls[1].text).toContain('SET search_indexed_at = now()');
    expect(sql.calls[1].values[1]).toHaveLength(50);
    expect(sql.calls[2].values[1]).toHaveLength(10);
  });

  it('never throws and does nothing without Meilisearch', async () => {
    const sql = createMockSql();
    await indexSyncedTasks(sql, {}, USER_ID, ['x']);
    expect(sql.calls).toHaveLength(0);

    const failing = createMockSql([[{ id: 'a' }]]);
    const addDocuments = vi.fn(async () => {
      throw new Error('meili down');
    });
    await expect(
      indexSyncedTasks(failing, env, USER_ID, [], { addDocuments }),
    ).resolves.toBeUndefined();
  });
});

describe('syncConnection', () => {
  const connection = { userId: USER_ID, token: 'tok', timeZone: ZONE, lastSyncedAt: null };

  it('records a failed run with a safe message and rethrows', async () => {
    const sql = createMockSql([[]]);
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(
      syncConnection(sql, /** @type {any} */ ({}), connection, {
        fetchImpl: /** @type {any} */ (fetchImpl),
      }),
    ).rejects.toBeInstanceOf(TodoistAuthError);
    expect(sql.calls[0].text).toContain('UPDATE todoist_connections');
    expect(sql.calls[0].values).toContain('failed');
    expect(sql.calls[0].values).toContain('Todoist rejected the saved token. Enter a new one.');
  });

  it('applies under the owner lock, records the summary and defers indexing on the request queue', async () => {
    const fetchImpl = vi.fn(async (/** @type {any} */ url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/by_completion_date'))
        return jsonResponse({ items: [], next_cursor: null });
      if (path.endsWith('/tasks')) {
        return jsonResponse({
          results: [{ id: 't', content: 'Hi', project_id: 'p', priority: 1, child_order: 1 }],
          next_cursor: null,
        });
      }
      if (path.endsWith('/projects')) {
        return jsonResponse({
          results: [{ id: 'p', name: 'P', child_order: 1 }],
          next_cursor: null,
        });
      }
      return jsonResponse({ results: [], next_cursor: null });
    });
    const sql = createMockSql([
      [{ id: 'p-row', todoistId: 'p' }],
      [],
      [],
      [],
      [{ id: 't-row', todoistId: 't', parentId: null }],
      [],
      [],
      [], // recordSyncResult
    ]);
    const deferSearchSync = vi.fn();
    const now = new Date('2026-10-15T09:00:00Z');

    const summary = await syncConnection(
      sql,
      /** @type {any} */ ({ deferSearchSync }),
      { ...connection, lastSyncedAt: new Date('2026-10-14T08:00:00Z') },
      { fetchImpl: /** @type {any} */ (fetchImpl), now: () => now },
    );

    expect(summary).toEqual({
      projects: 1,
      sections: 0,
      tasks: 1,
      completed: 0,
      removed: 0,
      skipped: 0,
    });
    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(sql.controlCalls[0].text).toContain('pg_advisory_xact_lock');
    const record = sql.calls.at(-1);
    expect(record.text).toContain('UPDATE todoist_connections');
    expect(record.values).toContain('ok');
    expect(record.values).toContainEqual(now);
    expect(deferSearchSync).toHaveBeenCalledWith(expect.any(Function), `todoist:${USER_ID}`);

    // The completed window reaches back an hour before the last run.
    const completedUrl = new URL(
      String(fetchImpl.mock.calls.find(([url]) => String(url).includes('by_completion_date'))?.[0]),
    );
    expect(completedUrl.searchParams.get('since')).toBe('2026-10-14T07:00:00.000Z');
  });

  it('looks a month back for completions on a first run', async () => {
    const fetchImpl = vi.fn(async (/** @type {any} */ url) =>
      jsonResponse(
        String(url).includes('by_completion_date')
          ? { items: [], next_cursor: null }
          : { results: [], next_cursor: null },
      ),
    );
    const sql = createMockSql([[], [], [], [], []]);
    const now = new Date('2026-10-15T09:00:00Z');
    await syncConnection(sql, /** @type {any} */ ({}), connection, {
      fetchImpl: /** @type {any} */ (fetchImpl),
      now: () => now,
    });
    const completedUrl = new URL(
      String(fetchImpl.mock.calls.find(([url]) => String(url).includes('by_completion_date'))?.[0]),
    );
    expect(completedUrl.searchParams.get('since')).toBe(
      new Date(now.getTime() - COMPLETED_LOOKBACK_MS).toISOString(),
    );
  });
});

describe('describeSyncFailure', () => {
  it('names the kind of failure without echoing anything from the request', () => {
    expect(describeSyncFailure(new TodoistAuthError(401, '/tasks'))).toMatch(
      /rejected the saved token/,
    );
    expect(describeSyncFailure(new TodoistApiError(503, '/tasks'))).toBe('Todoist responded 503.');
    expect(describeSyncFailure(new Error('postgres://user:pw@host'))).toBe(
      'The sync failed. Try again later.',
    );
  });
});

describe('isSyncHour', () => {
  it('judges the 07:00–20:00 window in the given zone, following its daylight saving', () => {
    // British Summer Time: UTC+1.
    expect(isSyncHour(new Date('2026-07-01T05:30:00Z'), ZONE)).toBe(false); // 06:30
    expect(isSyncHour(new Date('2026-07-01T06:30:00Z'), ZONE)).toBe(true); // 07:30
    expect(isSyncHour(new Date('2026-07-01T19:30:00Z'), ZONE)).toBe(true); // 20:30
    expect(isSyncHour(new Date('2026-07-01T20:30:00Z'), ZONE)).toBe(false); // 21:30
    // Winter: UTC+0.
    expect(isSyncHour(new Date('2026-12-01T06:30:00Z'), ZONE)).toBe(false);
    expect(isSyncHour(new Date('2026-12-01T07:00:00Z'), ZONE)).toBe(true);
    expect(isSyncHour(new Date('2026-12-01T20:59:00Z'), ZONE)).toBe(true);
    expect(isSyncHour(new Date('2026-12-01T21:00:00Z'), ZONE)).toBe(false);
  });

  it('falls back to Europe/London for a missing or unknown zone', () => {
    expect(isSyncHour(new Date('2026-12-01T07:00:00Z'), null)).toBe(true);
    expect(isSyncHour(new Date('2026-12-01T07:00:00Z'), 'Mars/Olympus')).toBe(true);
    expect(isSyncHour(new Date('2026-12-01T07:00:00Z'), 'America/Los_Angeles')).toBe(false);
  });
});
