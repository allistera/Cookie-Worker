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

it('defers indexing to a fresh connection and waits for completion before stamping', async () => {
  const requestSql = createMockSql([]);
  const backgroundSql = createMockSql([[{ id: DOC_ID, row_version: '42' }], []]);
  let job;
  let complete;
  const push = vi.fn(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await syncDocumentToMeili(
    requestSql,
    {
      ...ENV,
      deferSearchSync: (work) => {
        job = work;
      },
    },
    DOC_ID,
    { addDocuments: push },
  );
  expect(requestSql.calls).toHaveLength(0);
  expect(push).not.toHaveBeenCalled();
  const background = job(backgroundSql);
  await Promise.resolve();
  expect(backgroundSql.calls).toHaveLength(1);
  complete({ taskUid: 7, status: 'succeeded' });
  await background;
  expect(backgroundSql.calls[1].values).toContain('42');
  expect(backgroundSql.calls[1].text).toContain('xmin::text');
});
