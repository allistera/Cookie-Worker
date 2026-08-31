// Re-pushes rows Meilisearch never received. A save-time sync failure
// (syncMessageToMeili/syncDocumentToMeili swallow their own errors so a
// document/message save is never blocked by search indexing) leaves
// search_indexed_at behind updated_at; this is the only thing that repairs
// it. Run weekly by .github/workflows/search-drift-repair.yml.
//
// Each Meilisearch push gets three attempts with exponential backoff,
// retrying only on 5xx and network errors — a 4xx means we sent something
// wrong and retrying just burns time. This exists because the old embedding
// workflow died on a single transient 520 and lost a week of repair.
//
// Usage: DATABASE_URL=... MEILISEARCH_URL=... MEILISEARCH_API_KEY=... \
//        OPENAI_API_KEY=... node scripts/repair-search-drift.js

import process from 'node:process';
import postgres from 'postgres';
import { addDocuments } from '../shared/meili.js';
import { retryMeiliCall } from './lib/meiliRetry.js';
import { DRIFT_QUERIES, stampIndexed } from './lib/queries.js';
import { DESCRIPTORS, TARGETS } from './lib/targets.js';

const PAGE_SIZE = 500;

/**
 * @param {import('postgres').Sql} sql
 * @param {any} env
 * @param {'documents' | 'messages'} target
 */
async function repairTarget(sql, env, target) {
  const descriptor = DESCRIPTORS[target];

  let total = 0;
  for (;;) {
    const rows = await DRIFT_QUERIES[target](sql, { limit: PAGE_SIZE });
    if (rows.length === 0) break;

    await retryMeiliCall(() => addDocuments(env, descriptor, rows));
    const ids = rows.map((row) => String(row.id));
    await stampIndexed(sql, target, ids);

    total += rows.length;
    console.log(`[${target}] repaired ${total} rows so far`);
  }
  console.log(`[${target}] done: ${total} rows repaired`);
}

async function main() {
  const { DATABASE_URL, MEILISEARCH_URL, MEILISEARCH_API_KEY, OPENAI_API_KEY } = process.env;
  if (!DATABASE_URL || !MEILISEARCH_URL || !MEILISEARCH_API_KEY || !OPENAI_API_KEY) {
    throw new Error(
      'DATABASE_URL, MEILISEARCH_URL, MEILISEARCH_API_KEY, and OPENAI_API_KEY must be set',
    );
  }

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
    for (const target of TARGETS) await repairTarget(sql, env, target);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
