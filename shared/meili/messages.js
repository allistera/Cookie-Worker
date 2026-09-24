import { EMBEDDER } from './embedder.js';

/**
 * The messages index. Attributes, ranking rules, and the document mapping
 * were originally lifted verbatim from a pre-descriptor configure/build path
 * in shared/meili.js (since removed) so that migration changed nothing about
 * how messages are indexed or ranked. The embedder is new: hybrid search did
 * not exist before that migration, so there was no prior behaviour to
 * preserve there.
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
    'from_address',
    'to_address',
    'is_spam',
    'scheduled_for',
  ],
  sortable: ['sent_at'],
  // Recency breaks ties only after all textual relevance rules.
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'sent_at:desc'],
  typoTolerance: {
    minWordSizeForTypos: { oneTypo: 6, twoTypos: 12 },
    disableOnAttributes: ['from_address', 'to_address'],
    disableOnNumbers: true,
  },
  rankingScoreThreshold: 0.5,
  semanticRatio: 0.5,
  // Subject and body only: the same text the app embedded itself. Addresses
  // and labels stay searchable but out of the vector, so a label never
  // dilutes what a message is about.
  embedder: {
    ...EMBEDDER,
    documentTemplate: '{{doc.subject}}\n\n{{doc.body}}',
  },
  // recipients is a jsonb object shaped {to, cc, bcc}, each an array of
  // strings or {name, address} objects, and to_name/to_address are
  // filterable/searchable arrays (not joined strings). is_spam/scheduled_for
  // exist to let meiliMessageFilter reproduce the folder-filter table in
  // meili.js exactly for in:spam/snoozed/inbox — is_spam comes from
  // message_ai.spam_verdict (absent/non-'spam' means false), and
  // scheduled_for is epoch seconds like sent_at, with 0 standing in for
  // NULL so `scheduled_for <= now` alone covers Postgres's
  // "IS NULL OR <= now()".
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
      scheduled_for: msg.scheduled_for
        ? Math.floor(new Date(msg.scheduled_for).getTime() / 1000)
        : 0,
      is_unread: Boolean(msg.is_unread),
      is_starred: Boolean(msg.is_starred),
      is_archived: Boolean(msg.is_archived),
      is_sent: Boolean(msg.is_sent),
      // Reuse the existing exclusion filter during staged rollout; the owned
      // Postgres hydration also rejects held rows while index updates catch up.
      is_deleted: Boolean(msg.is_deleted) || ['held', 'blocked'].includes(msg.screening_status),
      has_attachments: Boolean(msg.has_attachments),
      is_spam: msg.spam_verdict === 'spam',
    };
  },
};
