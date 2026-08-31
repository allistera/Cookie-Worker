import { beforeEach, describe, expect, it, vi } from 'vitest';

const addDocuments = vi.fn();
vi.mock('./meili.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, addDocuments: (...args) => addDocuments(...args) };
});

const { MEILI_CHUNK_SIZE, syncMessageToMeili, syncMessagesToMeili } =
  await import('./meiliSync.js');

const ENV = { MEILISEARCH_URL: 'https://meili.test', MEILISEARCH_API_KEY: 'key' };
const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID_2 = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  addDocuments.mockReset();
  addDocuments.mockResolvedValue({ taskUid: 1 });
});

// A minimal postgres.js-shaped tagged-template mock: records the composed
// query text and returns queued rows, FIFO — enough to assert on the SELECT
// this file issues without a real database. Mirrors the createMockSql
// pattern used by every other worker's tests.
/** @param {unknown[][]} results */
function createMockSql(results = []) {
  const queue = [...results];
  /** @type {{text: string}[]} */
  const calls = [];
  /** @type {any} */
  const sql = vi.fn((/** @type {any} */ strings) => {
    calls.push({ text: strings.join('?') });
    return Promise.resolve(queue.length ? queue.shift() : []);
  });
  sql.calls = calls;
  return sql;
}

/** @param {number} n */
function manyRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `row-${i}`,
    row_version: `v${i}`,
    user_id: 'u1',
    labels: [],
  }));
}

describe('syncMessageToMeili', () => {
  it('does nothing when Meilisearch is not configured', async () => {
    const sql = createMockSql([]);

    await expect(syncMessageToMeili(sql, {}, MESSAGE_ID)).resolves.toEqual({
      indexed: 0,
      failed: 0,
    });

    expect(sql).not.toHaveBeenCalled();
    expect(addDocuments).not.toHaveBeenCalled();
  });

  // spam_verdict (mapped to is_spam by MESSAGES_INDEX.toDocument) and the
  // spam/snoozed/inbox folder filters (meiliMessageFilter) both need
  // message_ai.spam_verdict on the row this pushes to Meilisearch — without
  // the join it would always compute false.
  it('joins message_ai and selects spam_verdict/scheduled_for, and passes the raw row through to addDocuments', async () => {
    const sql = createMockSql([
      [{ id: MESSAGE_ID, row_version: '4242', user_id: 'u1', labels: [], spam_verdict: 'spam' }],
      [],
    ]);

    const result = await syncMessageToMeili(sql, ENV, MESSAGE_ID);

    const selectText = sql.calls[0].text;
    expect(selectText).toContain('LEFT JOIN message_ai ai ON ai.message_id = m.id');
    expect(selectText).toContain('ai.spam_verdict');
    expect(selectText).toContain('m.scheduled_for');

    expect(addDocuments).toHaveBeenCalledTimes(1);
    // addDocuments applies descriptor.toDocument internally, so the row
    // passed through here is the raw Postgres row, not a built document.
    const rows = addDocuments.mock.calls[0][2];
    expect(rows[0]).toMatchObject({ id: MESSAGE_ID, spam_verdict: 'spam' });
    expect(result).toEqual({ indexed: 1, failed: 0 });
  });

  // The lost update this guards against: a writer marks the row NULL and
  // fires a sync, a second write marks it NULL again while that sync is in
  // flight, and the first sync then stamps now() over the second mark — the
  // row is left indexed without the second change, no longer NULL, and so
  // invisible to the drift sweep forever. The row is NULL at both ends of
  // that window, so only a version check closes it.
  it('reads xmin as a version token and stamps only while the row still matches it', async () => {
    const sql = createMockSql([
      [{ id: MESSAGE_ID, row_version: '4242', user_id: 'u1', labels: [] }],
      [],
    ]);

    await syncMessageToMeili(sql, ENV, MESSAGE_ID);

    expect(sql.calls[0].text).toContain('m.xmin::text AS row_version');

    const updateText = sql.calls[1].text;
    expect(updateText).toContain('SET search_indexed_at = now()');
    expect(updateText).toContain('m.xmin::text = v.row_version');
    // The version read from the SELECT is what the stamp is conditioned on,
    // so a row written since is not matched and stays NULL.
    expect(sql.mock.calls[1][1]).toEqual([MESSAGE_ID]);
    expect(sql.mock.calls[1][2]).toEqual(['4242']);
  });

  it('does nothing when the message has gone', async () => {
    const sql = createMockSql([[]]);

    await expect(syncMessageToMeili(sql, ENV, MESSAGE_ID)).resolves.toEqual({
      indexed: 0,
      failed: 0,
    });
    expect(addDocuments).not.toHaveBeenCalled();
  });

  it('reports the failure and leaves the row unstamped when the push is rejected', async () => {
    addDocuments.mockRejectedValueOnce(new Error('payload too large'));
    const sql = createMockSql([
      [{ id: MESSAGE_ID, row_version: '4242', user_id: 'u1', labels: [] }],
      [],
    ]);

    await expect(syncMessageToMeili(sql, ENV, MESSAGE_ID)).resolves.toEqual({
      indexed: 0,
      failed: 1,
    });
    // SELECT only: nothing may be stamped for a document Meilisearch refused.
    expect(sql).toHaveBeenCalledTimes(1);
  });
});

describe('syncMessagesToMeili', () => {
  it('is a no-op for an empty id list', async () => {
    const sql = createMockSql([]);

    await expect(syncMessagesToMeili(sql, ENV, [])).resolves.toEqual({ indexed: 0, failed: 0 });

    expect(sql).not.toHaveBeenCalled();
    expect(addDocuments).not.toHaveBeenCalled();
  });

  it('does nothing when Meilisearch is not configured', async () => {
    const sql = createMockSql([]);

    await expect(syncMessagesToMeili(sql, {}, [MESSAGE_ID])).resolves.toEqual({
      indexed: 0,
      failed: 0,
    });

    expect(sql).not.toHaveBeenCalled();
    expect(addDocuments).not.toHaveBeenCalled();
  });

  it('selects all ids in one query and pushes a small batch in one addDocuments call', async () => {
    const sql = createMockSql([
      [
        { id: MESSAGE_ID, row_version: '1', user_id: 'u1', labels: [], spam_verdict: null },
        { id: MESSAGE_ID_2, row_version: '2', user_id: 'u1', labels: [], spam_verdict: 'spam' },
      ],
      [],
    ]);

    const result = await syncMessagesToMeili(sql, ENV, [MESSAGE_ID, MESSAGE_ID_2]);

    // One SELECT, one UPDATE — not one round trip per id.
    expect(sql).toHaveBeenCalledTimes(2);
    const selectText = sql.calls[0].text;
    expect(selectText).toContain('WHERE m.id = ANY(');
    expect(selectText).toContain('GROUP BY m.id, ai.spam_verdict');

    expect(addDocuments).toHaveBeenCalledTimes(1);
    const rows = addDocuments.mock.calls[0][2];
    expect(rows).toHaveLength(2);
    expect(rows.map((/** @type {any} */ r) => r.id)).toEqual([MESSAGE_ID, MESSAGE_ID_2]);
    expect(result).toEqual({ indexed: 2, failed: 0 });
  });

  // A bulk mutation may target ids that no longer exist or were deleted
  // between the mutation and this sync — search_indexed_at must only move
  // forward for the ids Meilisearch actually got.
  it('only stamps search_indexed_at for the ids that came back, each against its own version', async () => {
    const sql = createMockSql([
      [{ id: MESSAGE_ID, row_version: '77', user_id: 'u1', labels: [] }],
      [],
    ]);

    await syncMessagesToMeili(sql, ENV, [MESSAGE_ID, MESSAGE_ID_2]);

    const updateText = sql.calls[1].text;
    expect(updateText).toContain('UPDATE messages m');
    expect(updateText).toContain('SET search_indexed_at = now()');
    expect(updateText).toContain('FROM unnest(');
    expect(updateText).toContain('m.id = v.id AND m.xmin::text = v.row_version');
    expect(sql.mock.calls[1][1]).toEqual([MESSAGE_ID]);
    expect(sql.mock.calls[1][2]).toEqual(['77']);
  });

  it('does nothing further when none of the ids resolve to a row', async () => {
    const sql = createMockSql([[]]);

    await expect(syncMessagesToMeili(sql, ENV, [MESSAGE_ID])).resolves.toEqual({
      indexed: 0,
      failed: 0,
    });

    expect(sql).toHaveBeenCalledTimes(1);
    expect(addDocuments).not.toHaveBeenCalled();
  });

  // The sweep hands over up to SWEEP_LIMIT (200) ids at once. In one
  // addDocuments call, a single document Meilisearch rejects would take all
  // 200 down with it, on this tick and on every tick after.
  it('pushes in chunks rather than one oversized call', async () => {
    const rows = manyRows(120);
    const sql = createMockSql([rows, []]);

    const result = await syncMessagesToMeili(
      sql,
      ENV,
      rows.map((row) => row.id),
    );

    expect(MEILI_CHUNK_SIZE).toBe(50);
    expect(addDocuments).toHaveBeenCalledTimes(3);
    expect(addDocuments.mock.calls.map((call) => call[2].length)).toEqual([50, 50, 20]);
    expect(result).toEqual({ indexed: 120, failed: 0 });
  });

  it('keeps going after a failing chunk and stamps only the chunks that were accepted', async () => {
    const rows = manyRows(120);
    const sql = createMockSql([rows, []]);
    // The middle chunk is refused; the third must still be attempted.
    addDocuments
      .mockResolvedValueOnce({ taskUid: 1 })
      .mockRejectedValueOnce(new Error('document too large'))
      .mockResolvedValueOnce({ taskUid: 3 });

    const result = await syncMessagesToMeili(
      sql,
      ENV,
      rows.map((row) => row.id),
    );

    expect(addDocuments).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ indexed: 70, failed: 50 });

    const stampedIds = sql.mock.calls[1][1];
    const stampedVersions = sql.mock.calls[1][2];
    expect(stampedIds).toHaveLength(70);
    // Chunks 1 and 3, never the ids of the chunk that failed — those stay
    // NULL so the drift sweep retries them.
    expect(stampedIds).toEqual([...rows.slice(0, 50), ...rows.slice(100)].map((row) => row.id));
    expect(stampedVersions).toEqual(
      [...rows.slice(0, 50), ...rows.slice(100)].map((row) => row.row_version),
    );
  });

  it('stamps nothing and reports every id failed when all chunks are rejected', async () => {
    const rows = manyRows(60);
    const sql = createMockSql([rows, []]);
    addDocuments.mockRejectedValue(new Error('meilisearch unreachable'));

    const result = await syncMessagesToMeili(
      sql,
      ENV,
      rows.map((row) => row.id),
    );

    expect(addDocuments).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ indexed: 0, failed: 60 });
    // SELECT only — no stamp at all.
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('reports every id failed when the select itself throws', async () => {
    /** @type {any} */
    const sql = vi.fn(() => Promise.reject(new Error('connection lost')));

    await expect(syncMessagesToMeili(sql, ENV, [MESSAGE_ID, MESSAGE_ID_2])).resolves.toEqual({
      indexed: 0,
      failed: 2,
    });
    expect(addDocuments).not.toHaveBeenCalled();
  });

  it('still counts accepted documents when the stamp itself fails', async () => {
    const rows = manyRows(2);
    /** @type {any} */
    const sql = vi.fn((/** @type {any} */ strings) =>
      strings.join('?').includes('UPDATE')
        ? Promise.reject(new Error('connection lost'))
        : Promise.resolve(rows),
    );

    await expect(
      syncMessagesToMeili(
        sql,
        ENV,
        rows.map((row) => row.id),
      ),
    ).resolves.toEqual({ indexed: 2, failed: 0 });
  });
});
