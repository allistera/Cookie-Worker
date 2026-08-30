// Backfills all non-deleted messages into Meilisearch. Safe to re-run: the
// same documents will be updated by primary key. Run with DATABASE_URL,
// MEILISEARCH_URL, and MEILISEARCH_API_KEY in the environment.

import process from 'node:process';

import postgres from 'postgres';

import {
  addMeiliDocuments,
  buildMeiliDocument,
  configureMeiliIndex,
  meiliAvailable,
} from '../shared/meili.js';

const BATCH_SIZE = 100;

const { DATABASE_URL, MEILISEARCH_URL, MEILISEARCH_API_KEY, MEILISEARCH_INDEX } = process.env;

if (!DATABASE_URL || !MEILISEARCH_URL || !MEILISEARCH_API_KEY) {
  console.error('DATABASE_URL, MEILISEARCH_URL, and MEILISEARCH_API_KEY must be set');
  process.exit(1);
}

const env = {
  MEILISEARCH_URL,
  MEILISEARCH_API_KEY,
  MEILISEARCH_INDEX: MEILISEARCH_INDEX || 'messages',
};

if (!meiliAvailable(env)) {
  console.error('Meilisearch environment is not complete');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  ssl: 'require',
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

console.log('Configuring Meilisearch index...');
await configureMeiliIndex(env);

let total = 0;
let lastId = null;

for (;;) {
  const rows = await sql`
    SELECT
      m.id,
      m.user_id,
      m.from_name,
      m.from_address,
      m.recipients,
      m.subject,
      m.body_text,
      m.sent_at,
      m.is_unread,
      m.is_starred,
      m.is_archived,
      m.is_sent,
      m.is_deleted,
      EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_attachments,
      COALESCE(
        json_agg(json_build_object('name', l.name) ORDER BY l.name)
          FILTER (WHERE l.id IS NOT NULL),
        '[]'
      ) AS labels
    FROM messages m
    LEFT JOIN message_labels ml ON ml.message_id = m.id
    LEFT JOIN labels l ON l.id = ml.label_id
    WHERE m.is_deleted = false
      ${lastId ? sql`AND m.id > ${lastId}` : sql``}
    GROUP BY m.id
    ORDER BY m.id
    LIMIT ${BATCH_SIZE}
  `;

  if (rows.length === 0) break;

  const documents = rows.map(buildMeiliDocument);
  const result = await addMeiliDocuments(env, documents);
  console.log(JSON.stringify({ event: 'meili_backfill_batch', count: documents.length, task_uid: result.taskUid }));

  total += documents.length;
  lastId = rows[rows.length - 1].id;
}

console.log(`done: ${total} messages backfilled`);
await sql.end();
