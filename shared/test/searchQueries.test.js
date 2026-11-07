import { describe, expect, test } from 'vitest';
import { MESSAGES_INDEX } from '../meili/messages.js';
import { syncMessagesToMeili } from '../meiliSync.js';
import {
  documentsDriftBacklog,
  documentsDriftPage,
  messagesDriftBacklog,
  messagesDriftPage,
  messagesPage,
  taskItemsDriftBacklog,
  taskItemsDriftPage,
} from '../searchQueries.js';

const MESSAGE_ID = '00000000-0000-4000-8000-000000000001';
const MEILI_ENV = {
  MEILISEARCH_URL: 'https://meili.example.com',
  MEILISEARCH_API_KEY: 'test-key',
};

/**
 * A tagged-template stand-in that records each query's SQL text and returns no
 * rows, so the builders and the write-time sync can be read without a database.
 */
function recordingSql() {
  /** @type {string[]} */
  const queries = [];
  /** @type {any} */
  const sql = async (/** @type {TemplateStringsArray} */ strings) => {
    queries.push(strings.join('?'));
    return [];
  };
  return { sql, queries };
}

/** @param {string[]} queries */
function messageQuery(queries) {
  return queries.find((text) => text.includes('FROM messages m'));
}

/**
 * The selected columns of a message query, whitespace collapsed, so queries are
 * compared by what they read rather than by how their SQL is laid out.
 * @param {string | undefined} text
 */
function selectedColumns(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat
    .slice(flat.indexOf('SELECT') + 'SELECT'.length, flat.indexOf(' FROM messages m'))
    .trim();
}

describe('message search documents', () => {
  // The write-time sync, the reindex page and the drift page all feed
  // MESSAGES_INDEX.toDocument. A column one of them omits changes the document
  // it indexes, so all three must select the same columns.
  test('every message query selects the columns the write-time sync reads', async () => {
    const sync = recordingSql();
    await syncMessagesToMeili(sync.sql, MEILI_ENV, [MESSAGE_ID]);
    const page = recordingSql();
    await messagesPage(page.sql, { afterId: null, limit: 10 });
    const drift = recordingSql();
    await messagesDriftPage(drift.sql, { limit: 10 });

    const reference = selectedColumns(messageQuery(sync.queries));
    expect(reference).toContain('m.screening_status');
    expect(selectedColumns(messageQuery(page.queries))).toBe(reference);
    expect(selectedColumns(messageQuery(drift.queries))).toBe(reference);
  });

  test('a held or blocked message indexes as deleted, so it cannot be searched', () => {
    const row = {
      id: MESSAGE_ID,
      user_id: 'user-1',
      recipients: { to: [], cc: [], bcc: [] },
      labels: [],
    };
    expect(MESSAGES_INDEX.toDocument({ ...row, screening_status: 'allowed' }).is_deleted).toBe(
      false,
    );
    expect(MESSAGES_INDEX.toDocument({ ...row, screening_status: 'held' }).is_deleted).toBe(true);
    expect(MESSAGES_INDEX.toDocument({ ...row, screening_status: 'blocked' }).is_deleted).toBe(
      true,
    );
  });
});

describe('drift backlog', () => {
  /** @param {string} text */
  const predicate = (text) => text.replace(/\s+/g, ' ').split(' WHERE ')[1]?.split(' ORDER BY ')[0];

  // A backlog count that used a different predicate from its drift page would
  // report rows the sweep never selects, or miss rows it does.
  test("the documents and messages counts use their drift pages' predicates and partial indexes", async () => {
    const documents = recordingSql();
    await documentsDriftPage(documents.sql, { limit: 1 });
    await documentsDriftBacklog(documents.sql);
    expect(predicate(documents.queries[1]).trim()).toBe(predicate(documents.queries[0]).trim());
    expect(documents.queries[1]).toContain('count(*)');
    expect(documents.queries[1]).toContain('min(updated_at)');

    const messages = recordingSql();
    await messagesDriftPage(messages.sql, { limit: 1 });
    await messagesDriftBacklog(messages.sql);
    expect(predicate(messages.queries[1]).trim()).toBe(
      'search_indexed_at IS NULL GROUP BY m.id, ai.spam_verdict'.split(' GROUP')[0],
    );
    expect(messages.queries[1]).not.toContain('min(');
  });

  test('the task backlog drifts a parent on a sub-task edit and ages it by the newest edit in the tree', async () => {
    const tasks = recordingSql();
    await taskItemsDriftPage(tasks.sql, { limit: 1 });
    await taskItemsDriftBacklog(tasks.sql);
    const [page, backlog] = tasks.queries.map((text) => text.replace(/\s+/g, ' '));
    expect(backlog).toContain("WHERE t.parent_id IS NULL AND t.kind = 'task'");
    expect(backlog).toContain('s.updated_at > t.search_indexed_at');
    expect(page).toContain('s.updated_at > t.search_indexed_at');
    expect(backlog).toContain('GREATEST(t.updated_at, (SELECT max(s.updated_at)');
  });
});
