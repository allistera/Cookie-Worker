import { Meilisearch } from 'meilisearch';

export { MESSAGES_INDEX } from './meili/messages.js';
export { EMBEDDER } from './meili/embedder.js';

const DEFAULT_INDEX = 'messages';

/**
 * Checks whether Meilisearch Cloud is configured for this environment.
 *
 * @param {any} env
 * @returns {boolean}
 */
export function meiliAvailable(env) {
  return Boolean(env.MEILISEARCH_URL && env.MEILISEARCH_API_KEY);
}

/**
 * Decides whether the current parsed query can be handled by Meilisearch. We
 * keep Postgres for from:/to:/in: because Meilisearch filters do not support
 * substring matching on addresses/names without an experimental feature, and
 * folder predicates are easier to express in SQL for now.
 *
 * @param {Record<string, unknown>} filters
 * @returns {boolean}
 */
export function meiliCanHandle(filters) {
  const unsupported = ['from', 'to', 'in'];
  return !unsupported.some((key) => filters[key] !== undefined);
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
 * in:done/sent replace the SQL folder predicates — queryParse.js's FOLDERS
 * set is {inbox, sent, spam, snoozed, done, all}; "done" is the archived
 * folder ("archived" itself is not a recognized value), and is_archived is
 * what it maps onto. in:trash is not currently a value the parser produces
 * (there is no trash folder in FOLDERS today), but the filter it would need
 * — is_deleted = true instead of the default exclusion below — is included
 * here anyway so this stays correct if that ever changes, matching the one
 * case where is_deleted must be `true` rather than the default `false`.
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

  if (filters.in === 'done') parts.push('is_archived = true');
  if (filters.in === 'sent') parts.push('is_sent = true');
  if (filters.in === 'trash') parts.push('is_deleted = true');

  if (filters.in !== 'trash') parts.push('is_deleted = false');

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
 * include `body_text`, `recipients` as jsonb, and an aggregated `labels` array
 * of {name} objects when available.
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
    is_unread: Boolean(msg.is_unread),
    is_starred: Boolean(msg.is_starred),
    is_archived: Boolean(msg.is_archived),
    is_sent: Boolean(msg.is_sent),
    is_deleted: Boolean(msg.is_deleted),
    has_attachments: Boolean(msg.has_attachments),
  };
}

/**
 * Ensures the messages index is configured for email search.
 *
 * @param {any} env
 */
export async function configureMeiliIndex(env) {
  const client = getClient(env);
  const index = client.index(env.MEILISEARCH_INDEX || DEFAULT_INDEX);

  await index.updateSearchableAttributes([
    'subject',
    'body',
    'from_name',
    'from_address',
    'labels',
    'to_name',
    'to_address',
  ]);

  await index.updateFilterableAttributes([
    'user_id',
    'labels',
    'is_unread',
    'is_starred',
    'is_archived',
    'is_sent',
    'is_deleted',
    'has_attachments',
    'sent_at',
  ]);

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
