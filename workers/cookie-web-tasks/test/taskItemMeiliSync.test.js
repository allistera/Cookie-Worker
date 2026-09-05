import { describe, expect, it, vi } from 'vitest';

import { createMockSql } from './helpers.js';
import { removeTaskItemFromMeili, syncTaskItemToMeili } from '../src/taskItemMeiliSync.js';

const ENV = { MEILISEARCH_URL: 'https://meili.test', MEILISEARCH_API_KEY: 'key' };
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const SUBTASK_ID = '22222222-2222-4222-8222-222222222222';

describe('syncTaskItemToMeili', () => {
  it('does nothing when Meilisearch is not configured', async () => {
    const sql = createMockSql([]);

    await syncTaskItemToMeili(sql, {}, TASK_ID);
    // The handlers are also exercised without any env at all (older tests,
    // and any caller that never wires one through) — that must stay a no-op,
    // not a crash.
    await syncTaskItemToMeili(sql, undefined, TASK_ID);

    expect(sql.calls).toHaveLength(0);
  });

  it('pushes the top-level row with its sub-task titles', async () => {
    const row = {
      id: TASK_ID,
      user_id: 'u1',
      content: 'Plan the trip',
      subtasks: ['Book flights'],
    };
    const sql = createMockSql([[{ id: TASK_ID }], [row], []]);
    const push = vi.fn(async () => ({ taskUid: 1 }));

    await syncTaskItemToMeili(sql, ENV, TASK_ID, { addDocuments: push });

    expect(sql.calls[0].text).toContain('WITH RECURSIVE');
    expect(sql.calls[1].text).toContain('c.parent_id = t.id');
    expect(push).toHaveBeenCalledTimes(1);
    expect(/** @type {any} */ (push).mock.calls[0][2][0]).toMatchObject({ id: TASK_ID });
  });

  // A sub-task has no document of its own — writing one re-pushes its root.
  it('walks a sub-task up to its root before pushing', async () => {
    const sql = createMockSql([[{ id: TASK_ID }], [{ id: TASK_ID, user_id: 'u1' }], []]);
    const push = vi.fn(async () => ({ taskUid: 1 }));

    await syncTaskItemToMeili(sql, ENV, SUBTASK_ID, { addDocuments: push });

    expect(sql.calls[0].values).toContain(SUBTASK_ID);
    expect(sql.calls[1].values).toContain(TASK_ID);
    expect(/** @type {any} */ (push).mock.calls[0][2][0]).toMatchObject({ id: TASK_ID });
  });

  it('does nothing when the task has gone', async () => {
    const sql = createMockSql([[]]);
    const push = vi.fn();

    await syncTaskItemToMeili(sql, ENV, TASK_ID, { addDocuments: push });

    expect(push).not.toHaveBeenCalled();
  });

  // A task write must not fail because search indexing did.
  it('swallows a Meilisearch failure', async () => {
    const sql = createMockSql([[{ id: TASK_ID }], [{ id: TASK_ID, user_id: 'u1' }]]);
    const push = vi.fn(async () => {
      throw new Error('meili down');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      syncTaskItemToMeili(sql, ENV, TASK_ID, { addDocuments: push }),
    ).resolves.toBeUndefined();
  });

  it('stamps search_indexed_at on the root after a successful push', async () => {
    const sql = createMockSql([[{ id: TASK_ID }], [{ id: TASK_ID, user_id: 'u1' }], []]);
    const push = vi.fn(async () => ({ taskUid: 1 }));

    await syncTaskItemToMeili(sql, ENV, SUBTASK_ID, { addDocuments: push });

    expect(sql.calls[2].text).toContain('search_indexed_at = CASE WHEN');
    expect(sql.calls[2].values).toContain(TASK_ID);
  });

  // Stamping a row Meilisearch rejected would hide it from the sweep forever.
  it('does not stamp when the push fails', async () => {
    const sql = createMockSql([[{ id: TASK_ID }], [{ id: TASK_ID, user_id: 'u1' }]]);
    const push = vi.fn(async () => {
      throw new Error('meili down');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await syncTaskItemToMeili(sql, ENV, TASK_ID, { addDocuments: push });

    expect(sql.calls).toHaveLength(2);
  });
});

describe('removeTaskItemFromMeili', () => {
  it('deletes by id', async () => {
    const remove = vi.fn(async () => ({ taskUid: 1 }));

    await removeTaskItemFromMeili(ENV, TASK_ID, { deleteDocuments: remove });

    expect(/** @type {any} */ (remove).mock.calls[0][2]).toEqual([TASK_ID]);
  });

  it('swallows a Meilisearch failure', async () => {
    const remove = vi.fn(async () => {
      throw new Error('meili down');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      removeTaskItemFromMeili(ENV, TASK_ID, { deleteDocuments: remove }),
    ).resolves.toBeUndefined();
  });
});

// A divider has nothing to find; the row read refuses it so nothing is pushed.
it('reads only task rows, so a divider is never pushed', async () => {
  const sql = createMockSql([[{ id: TASK_ID }], []]);
  const push = vi.fn(async () => ({ taskUid: 1 }));

  await syncTaskItemToMeili(sql, ENV, TASK_ID, { addDocuments: push });

  expect(sql.calls[1].text).toContain("t.kind = 'task'");
  expect(push).not.toHaveBeenCalled();
});
