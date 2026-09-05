import { vi } from 'vitest';

/**
 * A stand-in for the Meilisearch JS client, shaped like createMockSql: it
 * records what we asked for so tests assert our query, not Meilisearch's
 * behaviour. `responses` maps a method name to the value it resolves with.
 *
 * @param {Record<string, any>} responses
 */
export function createMockMeili(responses = {}) {
  const calls = [];
  const task = (uid) =>
    Object.assign(Promise.resolve({ taskUid: uid, status: 'enqueued' }), {
      waitTask: async () => responses.task ?? { uid, status: 'succeeded' },
    });
  const index = (name) => ({
    updateSettings: vi.fn((args) => {
      calls.push({ index: name, method: 'updateSettings', args });
      return task(1);
    }),
    addDocuments: vi.fn((docs, opts) => {
      calls.push({ index: name, method: 'addDocuments', args: { docs, opts } });
      return task(2);
    }),
    deleteDocuments: vi.fn((ids) => {
      calls.push({ index: name, method: 'deleteDocuments', args: ids });
      return task(3);
    }),
    search: vi.fn(async (text, params) => {
      calls.push({ index: name, method: 'search', args: { text, params } });
      return responses.search ?? { hits: [] };
    }),
  });
  return { client: { index }, calls };
}
