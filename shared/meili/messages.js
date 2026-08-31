import { EMBEDDER } from './embedder.js';

/**
 * The messages index. Attributes, ranking rules, and the document mapping
 * are lifted verbatim from the previous configureMeiliIndex/buildMeiliDocument
 * in shared/meili.js so this refactor changes nothing about how messages are
 * indexed or ranked. The embedder is new: hybrid search did not exist before
 * this migration, so there is no prior behaviour to preserve there.
 *
 * @param {Record<string, unknown>} message row from Postgres, including
 *   `body_text`, `recipients` as jsonb ({to, cc, bcc} arrays), and an
 *   aggregated `labels` array of {name} objects when available.
 */
export const MESSAGES_INDEX = {
  name: 'messages',
  primaryKey: 'id',
  searchable: ['subject', 'body', 'from_name', 'from_address', 'labels', 'to_name', 'to_address'],
  filterable: [
    'user_id',
    'labels',
    'is_unread',
    'is_starred',
    'is_archived',
    'is_sent',
    'is_deleted',
    'has_attachments',
    'sent_at',
  ],
  sortable: ['sent_at'],
  // Carried over from configureMeiliIndex's updateRankingRules call. These
  // happen to be Meilisearch's own defaults, but we set them explicitly so a
  // future default change upstream does not silently alter ranking here.
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  semanticRatio: 0.5,
  // Subject and body only: the same text the app embedded itself. Addresses
  // and labels stay searchable but out of the vector, so a label never
  // dilutes what a message is about.
  embedder: {
    ...EMBEDDER,
    documentTemplate: '{{doc.subject}}\n\n{{doc.body}}',
  },
  // Lifted unchanged from buildMeiliDocument: recipients is a jsonb object
  // shaped {to, cc, bcc}, each an array of strings or {name, address}
  // objects, and to_name/to_address are filterable/searchable arrays (not
  // joined strings).
  toDocument: (message) => {
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
  },
};
