import { Meilisearch } from 'meilisearch';

export { MESSAGES_INDEX } from './meili/messages.js';
export { EMBEDDER } from './meili/embedder.js';

const DEFAULT_INDEX = 'messages';

/**
 * Checks whether Meilisearch Cloud is configured for this environment.
 * Historically also gated whether search.js routed to Meilisearch at all;
 * its engine switch (Meilisearch by default, &engine=postgres for the old
 * path) no longer consults this for that decision. Kept exported and
 * unused per the plan's "delete nothing" rule — phase 2 owns removal.
 *
 * @param {any} env
 * @returns {boolean}
 */
export function meiliAvailable(env) {
  return Boolean(env.MEILISEARCH_URL && env.MEILISEARCH_API_KEY);
}

/**
 * Historically decided whether a parsed query could route to Meilisearch's
 * keyword leg at all, back when Meilisearch could not express from:/to:
 * (needed Postgres's substring match) or in: (needed Postgres's folder
 * predicates). meiliMessageFilter below now expresses all three, and
 * search.js's engine switch (Meilisearch by default, &engine=postgres for
 * the old three-leg path) doesn't call this any more. Kept exported and
 * unused per the plan's "delete nothing" rule — phase 2 owns removal.
 *
 * @param {Record<string, unknown>} filters
 * @returns {boolean}
 */
export function meiliCanHandle(filters) {
  const unsupported = ['from', 'to', 'in'];
  return !unsupported.some((key) => filters[key] !== undefined);
}

// Folder predicates, mirroring retrieval.js's folderClause (the ground
// truth) exactly:
//
//   all      NOT deleted
//   done     NOT deleted AND archived
//   sent     NOT deleted AND NOT archived AND is_sent
//   spam     NOT deleted AND NOT archived AND NOT sent AND spam_verdict = 'spam'
//   snoozed  NOT deleted AND NOT archived AND NOT sent AND spam_verdict <> 'spam' AND scheduled_for > now()
//   inbox    NOT deleted AND NOT archived AND NOT sent AND spam_verdict <> 'spam' AND (scheduled_for IS NULL OR scheduled_for <= now())
//   trash    is_deleted = true (not a value queryParse.js's FOLDERS produces
//            today, but included so this stays correct if that changes —
//            see meiliMessageFilter's own comment)
//   (none)   NOT deleted AND NOT archived
//
// is_spam stands in for spam_verdict = 'spam' (computed at index time from
// message_ai, false when there is no ai row — same as folderClause's
// COALESCE(ai.spam_verdict, 'inbox') <> 'spam'). scheduled_for is epoch
// seconds with 0 for NULL, so `scheduled_for <= now` alone covers Postgres's
// "IS NULL OR <= now()", and `scheduled_for > now` correctly excludes 0.
//
// @param {string | undefined} folder
// @returns {string[]}
function folderFilterParts(folder) {
  const now = Math.floor(Date.now() / 1000);
  if (folder === 'all') return ['is_deleted = false'];
  if (folder === 'done') return ['is_deleted = false', 'is_archived = true'];
  if (folder === 'sent') return ['is_deleted = false', 'is_archived = false', 'is_sent = true'];
  if (folder === 'spam') {
    return ['is_deleted = false', 'is_archived = false', 'is_sent = false', 'is_spam = true'];
  }
  if (folder === 'snoozed') {
    return [
      'is_deleted = false',
      'is_archived = false',
      'is_sent = false',
      'is_spam = false',
      `scheduled_for > ${now}`,
    ];
  }
  if (folder === 'inbox') {
    return [
      'is_deleted = false',
      'is_archived = false',
      'is_sent = false',
      'is_spam = false',
      `scheduled_for <= ${now}`,
    ];
  }
  if (folder === 'trash') return ['is_deleted = true'];
  return ['is_deleted = false', 'is_archived = false'];
}

/**
 * Structured message filters (see queryParse.js) as a Meilisearch filter
 * expression. user_id is added separately by hybridSearch/meiliKeywordLeg —
 * deliberately absent here so it is never duplicated.
 *
 * from:/to: are exact matches: Postgres did substring, but Meilisearch
 * filters can't express that without the experimental containsFilter, and
 * exact match is the accepted behaviour change for phase 1. to_address is a
 * filterable array on the index, so `=` matches any element, same as labels.
 *
 * in: replaces the SQL folder predicates via folderFilterParts above —
 * queryParse.js's FOLDERS set is {inbox, sent, spam, snoozed, done, all};
 * "done" is the archived folder ("archived" itself is not a recognized
 * value). in:trash is not currently a value the parser produces (there is
 * no trash folder in FOLDERS today), but the filter it would need —
 * is_deleted = true instead of the default exclusion — is included anyway
 * so this stays correct if that ever changes.
 *
 * @param {Record<string, any>} [filters]
 * @returns {string | undefined}
 */
export function meiliMessageFilter(filters = {}) {
  const parts = [];

  if (filters.from) parts.push(`from_address = '${escapeFilter(String(filters.from))}'`);
  if (filters.to) parts.push(`to_address = '${escapeFilter(String(filters.to))}'`);
  if (filters.tag) parts.push(`labels = '${escapeFilter(String(filters.tag))}'`);
  if (filters.hasAttachment) parts.push('has_attachments = true');
  if (filters.before) {
    parts.push(`sent_at < ${Math.floor(Date.parse(String(filters.before)) / 1000)}`);
  }
  if (filters.after) {
    parts.push(`sent_at >= ${Math.floor(Date.parse(String(filters.after)) / 1000)}`);
  }

  parts.push(...folderFilterParts(filters.in));

  return parts.join(' AND ') || undefined;
}

/**
 * @param {any} env
 * @returns {Meilisearch}
 */
function getClient(env) {
  return new Meilisearch({ host: env.MEILISEARCH_URL, apiKey: env.MEILISEARCH_API_KEY });
}

/**
 * Meilisearch keyword leg. Returns ids ordered by Meilisearch relevance.
 *
 * @param {any} env
 * @param {string} userId
 * @param {{text: string, filters: Record<string, unknown>}} spec
 * @param {number} limit
 * @returns {Promise<{id: string}[]>}
 */
export async function meiliKeywordLeg(env, userId, spec, limit) {
  const client = getClient(env);
  const index = client.index(env.MEILISEARCH_INDEX || DEFAULT_INDEX);

  const filterParts = [`user_id = '${userId}'`];
  const messageFilter = meiliMessageFilter(spec.filters);
  if (messageFilter) filterParts.push(messageFilter);

  const result = await index.search(spec.text, {
    filter: filterParts.join(' AND '),
    attributesToSearchOn: ['subject', 'body', 'from_name', 'from_address', 'labels'],
    attributesToRetrieve: ['id'],
    limit,
  });

  return result.hits.map((hit) => ({ id: hit.id }));
}

/**
 * Builds a Meilisearch document from a Postgres messages row. The row should
 * include `body_text`, `recipients` as jsonb, `spam_verdict` (from a
 * LEFT JOIN message_ai), `scheduled_for`, and an aggregated `labels` array
 * of {name} objects when available. Kept in sync with MESSAGES_INDEX's own
 * toDocument in meili/messages.js — see that function's comment for why
 * is_spam/scheduled_for exist.
 *
 * @param {Record<string, unknown>} message
 * @returns {Record<string, unknown>}
 */
export function buildMeiliDocument(message) {
  const msg = /** @type {any} */ (message);
  const recipients = msg.recipients || {};
  const to = [...(recipients.to || []), ...(recipients.cc || []), ...(recipients.bcc || [])];
  const addresses = to.map((r) => (typeof r === 'string' ? r : r?.address)).filter(Boolean);
  const names = to.map((r) => (typeof r === 'string' ? null : r?.name)).filter(Boolean);

  return {
    id: String(msg.id),
    user_id: String(msg.user_id),
    subject: String(msg.subject || ''),
    body: String(msg.body_text || ''),
    from_name: String(msg.from_name || ''),
    from_address: String(msg.from_address || ''),
    to_address: addresses,
    to_name: names,
    labels: (msg.labels || []).map((l) => String(l.name)),
    sent_at: msg.sent_at ? Math.floor(new Date(msg.sent_at).getTime() / 1000) : 0,
    scheduled_for: msg.scheduled_for ? Math.floor(new Date(msg.scheduled_for).getTime() / 1000) : 0,
    is_unread: Boolean(msg.is_unread),
    is_starred: Boolean(msg.is_starred),
    is_archived: Boolean(msg.is_archived),
    is_sent: Boolean(msg.is_sent),
    is_deleted: Boolean(msg.is_deleted),
    has_attachments: Boolean(msg.has_attachments),
    is_spam: msg.spam_verdict === 'spam',
  };
}

// The messages index's filterable attributes, shared by configureMeiliIndex
// below and MESSAGES_INDEX.filterable in meili/messages.js. Both configure
// paths must list the same attributes or they drift — see
// shared/test/meili.test.js's "both configure paths agree" test.
const LEGACY_MESSAGE_FILTERABLE = [
  'user_id',
  'labels',
  'is_unread',
  'is_starred',
  'is_archived',
  'is_sent',
  'is_deleted',
  'has_attachments',
  'sent_at',
  'from_address',
  'to_address',
  'is_spam',
  'scheduled_for',
];

/**
 * Ensures the messages index is configured for email search.
 *
 * @param {any} env
 * @param {any} [client] injected by tests
 */
export async function configureMeiliIndex(env, client) {
  const index = clientFor(env, client).index(env.MEILISEARCH_INDEX || DEFAULT_INDEX);

  await index.updateSearchableAttributes([
    'subject',
    'body',
    'from_name',
    'from_address',
    'labels',
    'to_name',
    'to_address',
  ]);

  await index.updateFilterableAttributes(LEGACY_MESSAGE_FILTERABLE);

  await index.updateSortableAttributes(['sent_at']);

  await index.updateRankingRules(['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness']);
}

/**
 * @param {any} env
 * @param {Record<string, unknown>[]} documents
 */
export async function addMeiliDocuments(env, documents) {
  const client = getClient(env);
  const index = client.index(env.MEILISEARCH_INDEX || DEFAULT_INDEX);
  return index.addDocuments(documents, { primaryKey: 'id' });
}

/**
 * @param {any} env
 * @param {string[]} ids
 */
export async function deleteMeiliDocuments(env, ids) {
  const client = getClient(env);
  const index = client.index(env.MEILISEARCH_INDEX || DEFAULT_INDEX);
  return index.deleteDocuments(ids);
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeFilter(value) {
  return value.replace(/[\\']/g, '\\$&');
}

/**
 * Resolves the client to use: the one injected by tests, or a real one built
 * from env.
 *
 * @param {any} env
 * @param {any} [client]
 */
function clientFor(env, client) {
  return client ?? getClient(env);
}

/**
 * Applies an index descriptor's settings — searchable/filterable/sortable
 * attributes, ranking rules, and the embedder — in one updateSettings call.
 *
 * @param {any} env
 * @param {any} descriptor an index descriptor, e.g. MESSAGES_INDEX
 * @param {any} [client] injected by tests
 */
export async function configureIndex(env, descriptor, client) {
  const index = clientFor(env, client).index(descriptor.name);
  await index.updateSettings({
    searchableAttributes: descriptor.searchable,
    filterableAttributes: descriptor.filterable,
    sortableAttributes: descriptor.sortable,
    ...(descriptor.rankingRules ? { rankingRules: descriptor.rankingRules } : {}),
    embedders: {
      default: { ...descriptor.embedder, apiKey: env.OPENAI_API_KEY },
    },
  });
}

/**
 * Maps rows through the descriptor's toDocument and pushes them to its index.
 *
 * @param {any} env
 * @param {any} descriptor
 * @param {Record<string, unknown>[]} rows
 * @param {any} [client]
 */
export function addDocuments(env, descriptor, rows, client) {
  const index = clientFor(env, client).index(descriptor.name);
  return index.addDocuments(rows.map(descriptor.toDocument), {
    primaryKey: descriptor.primaryKey,
  });
}

/**
 * @param {any} env
 * @param {any} descriptor
 * @param {string[]} ids
 * @param {any} [client]
 */
export function deleteDocuments(env, descriptor, ids, client) {
  return clientFor(env, client).index(descriptor.name).deleteDocuments(ids);
}

/**
 * One hybrid query against an index descriptor. user_id is always filtered:
 * Postgres did that with a WHERE clause, and leaving it off here would
 * return another user's rows — it is the only thing separating users once
 * retrieval leaves Postgres.
 *
 * @param {any} env
 * @param {any} descriptor
 * @param {{userId: string, text?: string, filter?: string, limit: number, semanticRatio?: number, sort?: string[]}} query
 * @param {any} [client]
 * @returns {Promise<{id: string}[]>}
 */
export async function hybridSearch(env, descriptor, query, client) {
  const index = clientFor(env, client).index(descriptor.name);
  const filters = [`user_id = '${escapeFilter(query.userId)}'`];
  if (query.filter) filters.push(query.filter);

  const result = await index.search(query.text ?? '', {
    limit: query.limit,
    filter: filters.join(' AND '),
    attributesToRetrieve: ['id'],
    ...(query.sort ? { sort: query.sort } : {}),
    hybrid: {
      embedder: 'default',
      semanticRatio: query.semanticRatio ?? descriptor.semanticRatio,
    },
  });
  return result.hits.map((hit) => ({ id: hit.id }));
}
