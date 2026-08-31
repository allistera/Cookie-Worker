import { describe, expect, it } from 'vitest';

import { createMockMeili } from './meiliClient.js';
import {
  MESSAGES_INDEX,
  addDocuments,
  configureIndex,
  deleteDocuments,
  hybridSearch,
} from '../meili.js';

const ENV = { MEILISEARCH_URL: 'https://meili.test', MEILISEARCH_API_KEY: 'key' };
const USER_ID = '99999999-9999-9999-9999-999999999999';

describe('index descriptors', () => {
  it('describes the messages index', () => {
    expect(MESSAGES_INDEX.name).toBe('messages');
    expect(MESSAGES_INDEX.primaryKey).toBe('id');
    expect(MESSAGES_INDEX.searchable).toContain('subject');
    expect(MESSAGES_INDEX.filterable).toContain('user_id');
  });

  // The embedder is what retires our own pipeline; the model must not drift.
  it('embeds with text-embedding-3-small at 1536 dimensions', () => {
    expect(MESSAGES_INDEX.embedder.source).toBe('openAi');
    expect(MESSAGES_INDEX.embedder.model).toBe('text-embedding-3-small');
    expect(MESSAGES_INDEX.embedder.dimensions).toBe(1536);
  });
});

describe('configureIndex', () => {
  it('sends settings and the embedder together', async () => {
    const { client, calls } = createMockMeili();

    await configureIndex(ENV, MESSAGES_INDEX, client);

    const [call] = calls;
    expect(call.index).toBe('messages');
    expect(call.method).toBe('updateSettings');
    expect(call.args.searchableAttributes).toEqual(MESSAGES_INDEX.searchable);
    expect(call.args.embedders.default.source).toBe('openAi');
  });

  // The key reaches Meilisearch through settings; without it the embedder is
  // configured but cannot embed.
  it('passes the OpenAI key to the embedder', async () => {
    const { client, calls } = createMockMeili();

    await configureIndex({ ...ENV, OPENAI_API_KEY: 'sk-test' }, MESSAGES_INDEX, client);

    expect(calls[0].args.embedders.default.apiKey).toBe('sk-test');
  });
});

describe('hybridSearch', () => {
  it('always filters by user_id', async () => {
    const { client, calls } = createMockMeili({ search: { hits: [{ id: 'a' }] } });

    await hybridSearch(ENV, MESSAGES_INDEX, { userId: USER_ID, text: 'roof', limit: 20 }, client);

    expect(calls[0].args.params.filter).toContain(`user_id = '${USER_ID}'`);
  });

  it('asks for hybrid ranking at the descriptor default', async () => {
    const { client, calls } = createMockMeili({ search: { hits: [] } });

    await hybridSearch(ENV, MESSAGES_INDEX, { userId: USER_ID, text: 'roof', limit: 20 }, client);

    expect(calls[0].args.params.hybrid).toEqual({ embedder: 'default', semanticRatio: 0.5 });
  });

  it('lets a caller override semanticRatio', async () => {
    const { client, calls } = createMockMeili({ search: { hits: [] } });

    await hybridSearch(
      ENV,
      MESSAGES_INDEX,
      { userId: USER_ID, text: 'roof', limit: 20, semanticRatio: 1 },
      client,
    );

    expect(calls[0].args.params.hybrid.semanticRatio).toBe(1);
  });

  it('ands extra filters onto the user filter', async () => {
    const { client, calls } = createMockMeili({ search: { hits: [] } });

    await hybridSearch(
      ENV,
      MESSAGES_INDEX,
      { userId: USER_ID, text: 'roof', filter: 'is_archived = false', limit: 20 },
      client,
    );

    expect(calls[0].args.params.filter).toBe(`user_id = '${USER_ID}' AND is_archived = false`);
  });

  it('returns hit ids in Meilisearch order', async () => {
    const { client } = createMockMeili({ search: { hits: [{ id: 'b' }, { id: 'a' }] } });

    const ids = await hybridSearch(
      ENV,
      MESSAGES_INDEX,
      { userId: USER_ID, text: 'roof', limit: 20 },
      client,
    );

    expect(ids).toEqual([{ id: 'b' }, { id: 'a' }]);
  });
});

describe('addDocuments', () => {
  it('maps rows through the descriptor and sends the primary key', async () => {
    const { client, calls } = createMockMeili();

    await addDocuments(
      ENV,
      MESSAGES_INDEX,
      [{ id: 'm1', user_id: USER_ID, subject: 'Roof', body_text: 'tiles', labels: [] }],
      client,
    );

    expect(calls[0].args.opts).toEqual({ primaryKey: 'id' });
    expect(calls[0].args.docs[0]).toMatchObject({ id: 'm1', subject: 'Roof' });
  });
});

describe('deleteDocuments', () => {
  it('deletes by id from the descriptor index', async () => {
    const { client, calls } = createMockMeili();

    await deleteDocuments(ENV, MESSAGES_INDEX, ['m1'], client);

    expect(calls[0]).toMatchObject({ index: 'messages', method: 'deleteDocuments', args: ['m1'] });
  });
});
