import { Meilisearch } from 'meilisearch';

export { MESSAGES_INDEX } from './meili/messages.js';
export { EMBEDDER } from './meili/embedder.js';

/**
 * Checks whether Meilisearch Cloud is configured for this environment. Used
 * by the sync paths (mail-app-ingest, cookie-web-tasks) to no-op when
 * Meilisearch isn't configured.
 *
 * @param {any} env
 * @returns {boolean}
 */
export function meiliAvailable(env) {
  return Boolean(env.MEILISEARCH_URL && env.MEILISEARCH_API_KEY);
}

// Folder predicates. This is the ground truth for folder-filter semantics —
// see meiliMessageFilter below, which builds a Meilisearch filter expression
// from these:
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
 * expression. user_id is added separately by hybridSearch — deliberately
 * absent here so it is never duplicated.
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
  // queryParse admits any YYYY-MM-DD shape, so `before:2026-13-45` reaches
  // here and parses to NaN. Emitting `sent_at < NaN` makes Meilisearch reject
  // the whole request, which surfaces as a 503 — a typo in a date operator
  // would take search down rather than simply not matching. Skip the clause.
  const before = Date.parse(String(filters.before));
  if (filters.before && Number.isFinite(before)) {
    parts.push(`sent_at < ${Math.floor(before / 1000)}`);
  }
  const after = Date.parse(String(filters.after));
  if (filters.after && Number.isFinite(after)) {
    parts.push(`sent_at >= ${Math.floor(after / 1000)}`);
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

/**
 * One index's leg of a federatedSearch call. Pagination (limit/offset) is
 * deliberately not here — Meilisearch federation paginates the merged result
 * list, not each query, so it lives in federatedSearch's `options` instead.
 *
 * @typedef {{
 *   descriptor: any,
 *   q?: string,
 *   filter?: string,
 *   semantic?: boolean,
 *   semanticRatio?: number,
 *   weight?: number,
 *   sort?: string[],
 * }} FederatedSearchUnit
 */

/**
 * Federated (cross-index) search via Meilisearch's /multi-search endpoint
 * with `federation` set, merging hits from several indexes into one
 * relevance-ranked list instead of running one index at a time. Mirrors
 * hybridSearch's security guarantee: user_id is filtered inside this
 * function for every unit, so a caller can never omit it for one leg of a
 * federated query.
 *
 * `semantic: false` on a unit omits `hybrid` entirely for that query (plain
 * keyword search, no embedding call) — matching the "mode=keyword is
 * keyword-only, no hybrid" contract type-ahead relies on. Any other value
 * (including undefined) applies hybrid at the unit's semanticRatio, falling
 * back to the descriptor's default.
 *
 * @param {any} env
 * @param {FederatedSearchUnit[]} units
 * @param {{userId: string, limit: number, offset?: number}} options
 * @param {any} [client]
 * @returns {Promise<{hits: {id: string, _federation: any}[], estimatedTotalHits: number}>}
 */
export async function federatedSearch(env, units, options, client) {
  const meili = clientFor(env, client);
  const userFilter = `user_id = '${escapeFilter(options.userId)}'`;

  const queries = units.map((unit) => {
    const filters = [userFilter];
    if (unit.filter) filters.push(unit.filter);

    return {
      indexUid: unit.descriptor.name,
      q: unit.q ?? '',
      filter: filters.join(' AND '),
      attributesToRetrieve: ['id'],
      ...(unit.sort ? { sort: unit.sort } : {}),
      ...(unit.semantic === false
        ? {}
        : {
            hybrid: {
              embedder: 'default',
              semanticRatio: unit.semanticRatio ?? unit.descriptor.semanticRatio,
            },
          }),
      ...(unit.weight !== undefined ? { federationOptions: { weight: unit.weight } } : {}),
    };
  });

  const result = await meili.multiSearch({
    federation: { limit: options.limit, offset: options.offset ?? 0 },
    queries,
  });

  return {
    hits: result.hits.map((hit) => ({ id: hit.id, _federation: hit._federation })),
    estimatedTotalHits: result.estimatedTotalHits ?? result.hits.length,
  };
}
