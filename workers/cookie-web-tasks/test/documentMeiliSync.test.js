import { describe, expect, it, vi } from 'vitest';

import { createMockSql } from './helpers.js';
import { removeDocumentFromMeili, syncDocumentToMeili } from '../src/documentMeiliSync.js';

const ENV = { MEILISEARCH_URL: 'https://meili.test', MEILISEARCH_API_KEY: 'key' };
const DOC_ID = '11111111-1111-4111-8111-111111111111';

describe('syncDocumentToMeili', () => {
  it('does nothing when Meilisearch is not configured', async () => {
    const sql = createMockSql([]);

    await syncDocumentToMeili(sql, {}, DOC_ID);

    expect(sql.calls).toHaveLength(0);
  });

  it('reads the row and pushes it', async () => {
    const sql = createMockSql([[{ id: DOC_ID, user_id: 'u1', title: 'Roof' }]]);
    const push = vi.fn(async () => ({ taskUid: 1 }));

    await syncDocumentToMeili(sql, ENV, DOC_ID, { addDocuments: push });

    expect(sql.calls[0].text).toContain('FROM documents');
    expect(push).toHaveBeenCalledTimes(1);
    expect(/** @type {any} */ (push).mock.calls[0][2][0]).toMatchObject({ id: DOC_ID });
  });

  it('does nothing when the document has gone', async () => {
    const sql = createMockSql([[]]);
    const push = vi.fn();

    await syncDocumentToMeili(sql, ENV, DOC_ID, { addDocuments: push });

    expect(push).not.toHaveBeenCalled();
  });

  // A save must not fail because search indexing did.
  it('swallows a Meilisearch failure', async () => {
    const sql = createMockSql([[{ id: DOC_ID, user_id: 'u1' }]]);
    const push = vi.fn(async () => {
      throw new Error('meili down');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      syncDocumentToMeili(sql, ENV, DOC_ID, { addDocuments: push }),
    ).resolves.toBeUndefined();
  });

  it('stamps search_indexed_at after a successful push', async () => {
    const sql = createMockSql([[{ id: DOC_ID, user_id: 'u1' }], []]);
    const push = vi.fn(async () => ({ taskUid: 1 }));

    await syncDocumentToMeili(sql, ENV, DOC_ID, { addDocuments: push });

    expect(sql.calls[1].text).toContain('search_indexed_at = CASE WHEN');
    expect(sql.calls[1].values).toContain(DOC_ID);
  });

  // Stamping a row Meilisearch rejected would hide it from the sweep forever.
  it('does not stamp when the push fails', async () => {
    const sql = createMockSql([[{ id: DOC_ID, user_id: 'u1' }]]);
    const push = vi.fn(async () => {
      throw new Error('meili down');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await syncDocumentToMeili(sql, ENV, DOC_ID, { addDocuments: push });

    expect(sql.calls).toHaveLength(1);
  });
});

describe('removeDocumentFromMeili', () => {
  it('deletes by id', async () => {
    const remove = vi.fn(async () => ({ taskUid: 1 }));

    await removeDocumentFromMeili(ENV, DOC_ID, { deleteDocuments: remove });

    expect(/** @type {any} */ (remove).mock.calls[0][2]).toEqual([DOC_ID]);
  });

  it('swallows a Meilisearch failure', async () => {
    const remove = vi.fn(async () => {
      throw new Error('meili down');
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      removeDocumentFromMeili(ENV, DOC_ID, { deleteDocuments: remove }),
    ).resolves.toBeUndefined();
  });
});

// Deferred jobs run alongside each other in the request's waitUntil queue, so
// each one still waits for its task and stamps search_indexed_at.
it('defers indexing to a fresh connection, waits for the task, and stamps', async () => {
  const requestSql = createMockSql([]);
  const backgroundSql = createMockSql([[{ id: DOC_ID, row_version: '42' }], []]);
  /** @type {any} */
  let job;
  /** @type {any} */
  let key;
  const push = vi.fn(async () => ({ taskUid: 7, status: 'enqueued' }));
  await syncDocumentToMeili(
    requestSql,
    {
      ...ENV,
      deferSearchSync: (/** @type {any} */ work, /** @type {any} */ jobKey) => {
        job = work;
        key = jobKey;
      },
    },
    DOC_ID,
    { addDocuments: push },
  );
  expect(requestSql.calls).toHaveLength(0);
  expect(push).not.toHaveBeenCalled();
  expect(key).toBe(`document:${DOC_ID}`);

  await job(backgroundSql);

  expect(/** @type {any} */ (push).mock.calls[0][4]).toEqual({ waitForTask: true });
  expect(backgroundSql.calls).toHaveLength(2);
  expect(backgroundSql.calls[1].text).toContain('search_indexed_at');
});

it('waits for the task outside the deferred queue', async () => {
  const sql = createMockSql([[{ id: DOC_ID, user_id: 'u1' }], []]);
  const push = vi.fn(async () => ({ taskUid: 1 }));

  await syncDocumentToMeili(sql, ENV, DOC_ID, { addDocuments: push });

  expect(/** @type {any} */ (push).mock.calls[0][4]).toEqual({ waitForTask: true });
});
