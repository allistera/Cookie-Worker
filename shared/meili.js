import { Meilisearch } from 'meilisearch';

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

  const filterParts = [`user_id = '${userId}'`, 'is_deleted = false'];
  if (spec.filters.tag) {
    filterParts.push(`labels = '${escapeFilter(String(spec.filters.tag))}'`);
  }
  if (spec.filters.hasAttachment) {
    filterParts.push('has_attachments = true');
  }
  if (spec.filters.before) {
    filterParts.push(`sent_at < ${Math.floor(Date.parse(String(spec.filters.before)) / 1000)}`);
  }
  if (spec.filters.after) {
    filterParts.push(`sent_at >= ${Math.floor(Date.parse(String(spec.filters.after)) / 1000)}`);
  }

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
  const to = [
    ...(recipients.to || []),
    ...(recipients.cc || []),
    ...(recipients.bcc || []),
  ];
  const addresses = to
    .map((r) => (typeof r === 'string' ? r : r?.address))
    .filter(Boolean);
  const names = to
    .map((r) => (typeof r === 'string' ? null : r?.name))
    .filter(Boolean);

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

  await index.updateRankingRules([
    'words',
    'typo',
    'proximity',
    'attribute',
    'sort',
    'exactness',
  ]);
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
  return value.replace(/[\\']/g, "\\$&");
}
