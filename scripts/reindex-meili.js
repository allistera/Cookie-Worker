// One-off: pushes every document and message into Meilisearch, which embeds
// them as it indexes. Idempotent — safe to re-run — and stamps
// search_indexed_at so the weekly drift sweep (repair-search-drift.js)
// starts from a clean baseline.
//
// configureIndex runs before any row of a target is pushed: a document
// indexed before the embedder exists gets no vector and is invisible to
// semantic search.
//
// Usage: DATABASE_URL=... MEILISEARCH_URL=... MEILISEARCH_API_KEY=... \
//        OPENAI_API_KEY=... node scripts/reindex-meili.js [documents|messages|task_items]
// With no argument, every index is reindexed.

import process from 'node:process';
import postgres from 'postgres';
import { addDocuments, configureIndex } from '../shared/meili.js';
import { PAGE_QUERIES, stampIndexed } from './lib/queries.js';
import { DESCRIPTORS, parseTargets } from './lib/targets.js';

const BATCH_SIZE = 100;

/**
 * @param {import('postgres').Sql} sql
 * @param {any} env
 * @param {import('./lib/targets.js').Target} target
 */
async function reindexTarget(sql, env, target) {
  const descriptor = DESCRIPTORS[target];

  await configureIndex(env, descriptor);
  console.log(`[${target}] index configured`);

  /** @type {string | null} */
  let afterId = null;
  let total = 0;
  for (;;) {
    const rows = await PAGE_QUERIES[target](sql, { afterId, limit: BATCH_SIZE });
    if (rows.length === 0) break;

    await addDocuments(env, descriptor, rows);
    const ids = rows.map((row) => String(row.id));
    await stampIndexed(sql, target, ids);

    total += rows.length;
    afterId = ids[ids.length - 1];
    console.log(`[${target}] indexed ${total} rows so far`);
  }
  console.log(`[${target}] done: ${total} rows indexed`);
}

async function main() {
  const { DATABASE_URL, MEILISEARCH_URL, MEILISEARCH_API_KEY, OPENAI_API_KEY } = process.env;
  if (!DATABASE_URL || !MEILISEARCH_URL || !MEILISEARCH_API_KEY || !OPENAI_API_KEY) {
    throw new Error(
      'DATABASE_URL, MEILISEARCH_URL, MEILISEARCH_API_KEY, and OPENAI_API_KEY must be set',
    );
  }

  const targets = parseTargets(process.argv.slice(2));
  const env = { MEILISEARCH_URL, MEILISEARCH_API_KEY, OPENAI_API_KEY };

  // ssl: 'require' and prepare: false mirror Cookie-Web's
  // scripts/backfill-embeddings.js, which connects to the same database the
  // same way (direct connection, not through Hyperdrive like the Workers do).
  const sql = postgres(DATABASE_URL, {
    ssl: 'require',
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });

  try {
    for (const target of targets) await reindexTarget(sql, env, target);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
