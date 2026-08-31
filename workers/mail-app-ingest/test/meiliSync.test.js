import { describe, expect, it, vi } from 'vitest';

const addDocuments = vi.fn();
addDocuments.mockResolvedValue({ taskUid: 1 });
vi.mock('../../../shared/meili.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, addDocuments: (...args) => addDocuments(...args) };
});

const { syncMessageToMeili } = await import('../src/meiliSync.js');

const ENV = { MEILISEARCH_URL: 'https://meili.test', MEILISEARCH_API_KEY: 'key' };
const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';

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

describe('syncMessageToMeili', () => {
  it('does nothing when Meilisearch is not configured', async () => {
    const sql = createMockSql([]);

    await syncMessageToMeili(sql, {}, MESSAGE_ID);

    expect(sql).not.toHaveBeenCalled();
    expect(addDocuments).not.toHaveBeenCalled();
  });

  // spam_verdict (mapped to is_spam by MESSAGES_INDEX.toDocument) and the
  // spam/snoozed/inbox folder filters (meiliMessageFilter) both need
  // message_ai.spam_verdict on the row this pushes to Meilisearch — without
  // the join it would always compute false.
  it('joins message_ai and selects spam_verdict/scheduled_for, and passes the raw row through to addDocuments', async () => {
    const sql = createMockSql([
      [{ id: MESSAGE_ID, user_id: 'u1', labels: [], spam_verdict: 'spam' }],
      [],
    ]);

    await syncMessageToMeili(sql, ENV, MESSAGE_ID);

    const selectText = sql.calls[0].text;
    expect(selectText).toContain('LEFT JOIN message_ai ai ON ai.message_id = m.id');
    expect(selectText).toContain('ai.spam_verdict');
    expect(selectText).toContain('m.scheduled_for');

    expect(addDocuments).toHaveBeenCalledTimes(1);
    // addDocuments applies descriptor.toDocument internally, so the row
    // passed through here is the raw Postgres row, not a built document.
    const rows = addDocuments.mock.calls[0][2];
    expect(rows[0]).toMatchObject({ id: MESSAGE_ID, spam_verdict: 'spam' });
  });

  it('does nothing when the message has gone', async () => {
    const sql = createMockSql([[]]);

    await expect(syncMessageToMeili(sql, ENV, MESSAGE_ID)).resolves.toBeUndefined();
    expect(addDocuments).not.toHaveBeenCalled();
  });
});
