import { describe, expect, it } from 'vitest';

import { createMockMeili } from './meiliClient.js';
import {
  MESSAGES_INDEX,
  addDocuments,
  configureIndex,
  deleteDocuments,
  hybridSearch,
  meiliMessageFilter,
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

// The single filter builder shared by hybridSearch (via search.js/ask.js)
// and meiliKeywordLeg below — see meiliKeywordLeg's own tests for the
// no-drift guarantee that both use this, not two hand-rolled copies.
describe('meiliMessageFilter', () => {
  it('excludes deleted messages by default', () => {
    expect(meiliMessageFilter({})).toBe('is_deleted = false');
  });

  it('matches from: and to: exactly', () => {
    const filter = meiliMessageFilter({ from: 'bob@example.com', to: 'jane@example.com' });
    expect(filter).toContain("from_address = 'bob@example.com'");
    expect(filter).toContain("to_address = 'jane@example.com'");
  });

  it('maps tag to labels and has:attachment to has_attachments', () => {
    const filter = meiliMessageFilter({ tag: 'Personal', hasAttachment: true });
    expect(filter).toContain("labels = 'Personal'");
    expect(filter).toContain('has_attachments = true');
  });

  // sent_at is stored in the index as epoch SECONDS, not milliseconds.
  it('filters before:/after: on sent_at in epoch seconds', () => {
    const filter = meiliMessageFilter({ before: '2026-01-31', after: '2026-01-01' });
    expect(filter).toContain(`sent_at < ${Math.floor(Date.parse('2026-01-31') / 1000)}`);
    expect(filter).toContain(`sent_at >= ${Math.floor(Date.parse('2026-01-01') / 1000)}`);
  });

  // queryParse.js's FOLDERS are {inbox, sent, spam, snoozed, done, all} —
  // "done" is the archived folder, not "archived".
  it('maps in:done to is_archived and in:sent to is_sent', () => {
    expect(meiliMessageFilter({ in: 'done' })).toContain('is_archived = true');
    expect(meiliMessageFilter({ in: 'sent' })).toContain('is_sent = true');
  });

  // The one case where deleted mail is wanted: is_deleted flips to true
  // instead of the default exclusion.
  it('flips is_deleted to true for in:trash instead of excluding it', () => {
    const filter = meiliMessageFilter({ in: 'trash' });
    expect(filter).toContain('is_deleted = true');
    expect(filter).not.toContain('is_deleted = false');
  });

  it('escapes a single quote and a backslash in from/to/tag values', () => {
    expect(meiliMessageFilter({ tag: "o'brien" })).toContain("labels = 'o\\'brien'");
    expect(meiliMessageFilter({ from: 'back\\slash' })).toContain("from_address = 'back\\\\slash'");
  });
});

// meiliKeywordLeg builds its own Meilisearch client from env (it predates
// the descriptor-based hybridSearch and takes no injectable client), so it
// isn't unit-tested at the network boundary here — same as before this
// change. What matters is covered above: meiliMessageFilter is the one
// filter builder, and this leg is asserted (by reading the source) to call
// it instead of the inline block it used to hand-roll.
