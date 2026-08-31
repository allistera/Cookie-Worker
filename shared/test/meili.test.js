import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Every attribute meiliMessageFilter/MESSAGES_INDEX's toDocument can put
// into a filter expression. MESSAGES_INDEX.filterable must list all of
// these or a filter Meilisearch rejects looks fine in code review and 503s
// in production — see "lists every attribute meiliMessageFilter can filter
// on" below.
const MESSAGE_FILTER_ATTRIBUTES = [
  'from_address',
  'to_address',
  'labels',
  'has_attachments',
  'sent_at',
  'is_archived',
  'is_sent',
  'is_deleted',
  'is_spam',
  'scheduled_for',
];

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

  // meiliMessageFilter builds expressions against from_address/to_address/
  // is_spam/scheduled_for (folder filters) alongside the older attributes —
  // Meilisearch rejects a filter on a non-filterable attribute outright, so
  // this list drifting from the filter builder is a 503, not a wrong answer.
  it('lists every attribute meiliMessageFilter can filter on', () => {
    for (const attr of MESSAGE_FILTER_ATTRIBUTES) {
      expect(MESSAGES_INDEX.filterable).toContain(attr);
    }
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

// MESSAGES_INDEX.toDocument is the only document mapping now — meiliSync.js
// (mail-app-ingest's write path) calls addDocuments with MESSAGES_INDEX
// directly, so there is no longer a second builder to keep in sync.
describe('MESSAGES_INDEX.toDocument — is_spam and scheduled_for', () => {
  const ROW = {
    id: 'm1',
    user_id: USER_ID,
    sent_at: '2026-01-15T00:00:00Z',
    scheduled_for: '2026-01-16T00:00:00Z',
    spam_verdict: 'spam',
  };

  it('is_spam is true only when spam_verdict is exactly "spam"', () => {
    expect(MESSAGES_INDEX.toDocument(ROW).is_spam).toBe(true);

    expect(MESSAGES_INDEX.toDocument({ ...ROW, spam_verdict: 'inbox' }).is_spam).toBe(false);
    // No message_ai row at all (LEFT JOIN yields undefined/null) must not
    // read as spam.
    expect(MESSAGES_INDEX.toDocument({ ...ROW, spam_verdict: undefined }).is_spam).toBe(false);
  });

  it('scheduled_for is epoch seconds, and 0 (not null) when unset', () => {
    const expected = Math.floor(Date.parse(ROW.scheduled_for) / 1000);
    expect(MESSAGES_INDEX.toDocument(ROW).scheduled_for).toBe(expected);

    expect(MESSAGES_INDEX.toDocument({ ...ROW, scheduled_for: null }).scheduled_for).toBe(0);
  });
});

// The filter builder used by hybridSearch (via search.js/ask.js).
//
// Ground truth is the folder-filter table in meili.js (folderFilterParts):
//   all      NOT deleted
//   done     NOT deleted AND archived
//   sent     NOT deleted AND NOT archived AND is_sent
//   spam     NOT deleted AND NOT archived AND NOT sent AND spam_verdict = 'spam'
//   snoozed  NOT deleted AND NOT archived AND NOT sent AND spam_verdict <> 'spam' AND scheduled_for > now()
//   inbox    NOT deleted AND NOT archived AND NOT sent AND spam_verdict <> 'spam' AND (scheduled_for IS NULL OR scheduled_for <= now())
//   (none)   NOT deleted AND NOT archived
describe('meiliMessageFilter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('excludes deleted and archived messages by default (no in: filter)', () => {
    expect(meiliMessageFilter({})).toBe('is_deleted = false AND is_archived = false');
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

  // A date operator that parses to NaN used to emit `sent_at < NaN`, which
  // Meilisearch rejects — so a typo took search down with a 503 instead of
  // simply not constraining the range.
  it('drops an unparseable before:/after: instead of emitting NaN', () => {
    const filter = meiliMessageFilter({ before: '2026-13-45', after: 'yesterday' });
    expect(filter ?? '').not.toContain('NaN');
    expect(filter ?? '').not.toContain('sent_at');
  });

  it('keeps a valid bound when the other one is unparseable', () => {
    const filter = meiliMessageFilter({ before: '2026-13-45', after: '2026-01-01' });
    expect(filter).toContain(`sent_at >= ${Math.floor(Date.parse('2026-01-01') / 1000)}`);
    expect(filter).not.toContain('NaN');
  });

  it('in:all excludes only deleted mail (archived mail is included)', () => {
    expect(meiliMessageFilter({ in: 'all' })).toBe('is_deleted = false');
  });

  // queryParse.js's FOLDERS are {inbox, sent, spam, snoozed, done, all} —
  // "done" is the archived folder, not "archived".
  it('in:done maps to is_archived = true', () => {
    expect(meiliMessageFilter({ in: 'done' })).toBe('is_deleted = false AND is_archived = true');
  });

  // Regression: the original implementation omitted "AND NOT is_archived",
  // so archived sent copies would have shown up under in:sent too.
  it('in:sent excludes deleted AND archived mail', () => {
    expect(meiliMessageFilter({ in: 'sent' })).toBe(
      'is_deleted = false AND is_archived = false AND is_sent = true',
    );
  });

  it('in:spam requires is_spam = true and excludes archived/sent mail', () => {
    expect(meiliMessageFilter({ in: 'spam' })).toBe(
      'is_deleted = false AND is_archived = false AND is_sent = false AND is_spam = true',
    );
  });

  it('in:snoozed requires scheduled_for in the future, and excludes spam', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(meiliMessageFilter({ in: 'snoozed' })).toBe(
      `is_deleted = false AND is_archived = false AND is_sent = false AND is_spam = false AND scheduled_for > ${now}`,
    );
  });

  // scheduled_for is stored as 0 (not null) when unset, so a single
  // `<= now` comparison covers Postgres's "IS NULL OR <= now()".
  it('in:inbox requires scheduled_for now-or-past, and excludes spam', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(meiliMessageFilter({ in: 'inbox' })).toBe(
      `is_deleted = false AND is_archived = false AND is_sent = false AND is_spam = false AND scheduled_for <= ${now}`,
    );
  });

  // The one case where deleted mail is wanted: is_deleted flips to true
  // instead of the default exclusion. Not a value queryParse.js's FOLDERS
  // produces today (see the file's own comment), but must stay correct.
  it('in:trash flips is_deleted to true instead of excluding it', () => {
    expect(meiliMessageFilter({ in: 'trash' })).toBe('is_deleted = true');
  });

  // An unrecognized in: value (should never reach here — queryParse.js
  // rejects it — but defensively) falls back to the same default as no
  // filter at all, never to something more permissive.
  it('falls back to the default exclusion for an unrecognized folder', () => {
    expect(meiliMessageFilter({ in: 'bogus' })).toBe('is_deleted = false AND is_archived = false');
  });

  it('escapes a single quote and a backslash in from/to/tag values', () => {
    expect(meiliMessageFilter({ tag: "o'brien" })).toContain("labels = 'o\\'brien'");
    expect(meiliMessageFilter({ from: 'back\\slash' })).toContain("from_address = 'back\\\\slash'");
  });
});
