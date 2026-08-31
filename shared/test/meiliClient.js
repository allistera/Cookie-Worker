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
  const index = (name) => ({
    updateSettings: vi.fn(async (args) => {
      calls.push({ index: name, method: 'updateSettings', args });
      return { taskUid: 1 };
    }),
    addDocuments: vi.fn(async (docs, opts) => {
      calls.push({ index: name, method: 'addDocuments', args: { docs, opts } });
      return { taskUid: 2 };
    }),
    deleteDocuments: vi.fn(async (ids) => {
      calls.push({ index: name, method: 'deleteDocuments', args: ids });
      return { taskUid: 3 };
    }),
    search: vi.fn(async (text, params) => {
      calls.push({ index: name, method: 'search', args: { text, params } });
      return responses.search ?? { hits: [] };
    }),
    // The legacy per-attribute update* calls configureMeiliIndex makes
    // (superseded by updateSettings/configureIndex, but kept — and still
    // tested — per the plan's "delete nothing" rule).
    updateSearchableAttributes: vi.fn(async (args) => {
      calls.push({ index: name, method: 'updateSearchableAttributes', args });
      return { taskUid: 4 };
    }),
    updateFilterableAttributes: vi.fn(async (args) => {
      calls.push({ index: name, method: 'updateFilterableAttributes', args });
      return { taskUid: 5 };
    }),
    updateSortableAttributes: vi.fn(async (args) => {
      calls.push({ index: name, method: 'updateSortableAttributes', args });
      return { taskUid: 6 };
    }),
    updateRankingRules: vi.fn(async (args) => {
      calls.push({ index: name, method: 'updateRankingRules', args });
      return { taskUid: 7 };
    }),
  });
  return { client: { index }, calls };
}
