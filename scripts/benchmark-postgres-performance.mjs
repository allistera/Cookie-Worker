// Local-only synthetic benchmark; requires cookie_performance on the local PostgreSQL Unix socket.
import postgres from 'postgres';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cookie-benchmark-'));
const baselineFile = path.join(temporary, 'emails-before.mjs');
await fs.writeFile(
  baselineFile,
  execFileSync('git', ['show', 'cf91645:workers/cookie-web-emails/src/emails.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  }),
);
const { fetchEmails: before } = await import(pathToFileURL(baselineFile).href);
import { fetchEmails as after } from '../workers/cookie-web-emails/src/emails.js';
import assert from 'node:assert/strict';
const sql = postgres({
  host: '/var/run/postgresql',
  database: 'cookie_performance',
  max: 1,
  prepare: false,
});
const schema = `benchmark_${randomUUID().replaceAll('-', '')}`;
try {
  await sql`CREATE SCHEMA ${sql(schema)}`;
  await sql`SET search_path TO ${sql(schema)}`;
  await sql.unsafe(
    await fs.readFile(new URL('../test/fixtures/inbox-benchmark.sql', import.meta.url), 'utf8'),
  );
  await sql`CREATE INDEX messages_follow_up_page_idx ON messages (user_id, follow_up_at DESC, id DESC)
  WHERE is_sent AND NOT is_deleted AND NOT is_archived AND follow_up_at IS NOT NULL`;
  await sql`CREATE INDEX messages_thread_latest_idx ON messages (user_id, thread_id, sent_at DESC, id DESC) WHERE NOT is_deleted`;
  const user = '11111111-1111-4111-8111-111111111111';
  function explain(strings, ...values) {
    if (strings.join('').includes('m.from_name'))
      strings = ['EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + strings[0], ...strings.slice(1)];
    if (!strings.raw) Object.defineProperty(strings, 'raw', { value: [...strings] });
    return sql(strings, ...values);
  }
  for (const folder of ['inbox', 'sent', 'spam', 'snoozed', 'done', 'starred', 'label']) {
    /** @type {{sentAt: string, id: string} | null} */
    let cursor = null;
    for (let page = 0; page < 3; page++) {
      const oldRows = await before(sql, user, 50, cursor, folder, 'Work');
      const newRows = await after(sql, user, 50, cursor, folder, 'Work');
      assert.deepEqual(
        newRows.map(({ sort_cursor: _sortCursor, ...row }) => row),
        [...oldRows],
      );
      const last = newRows[49];
      if (!last) break;
      cursor = { sentAt: last.sort_cursor, id: last.id };
    }
  }
  const times = { before: [], after: [] };
  for (let i = 0; i < 5; i++) {
    for (const [name, query] of [
      ['before', before],
      ['after', after],
    ]) {
      const [row] = await query(explain, user, 50, null, 'inbox');
      const plan = row['QUERY PLAN'][0];
      times[name].push(plan['Execution Time']);
    }
  }
  console.log(
    JSON.stringify({ messages: 100000, equivalentFolderPages: 21, executionMs: times }, null, 2),
  );
} finally {
  await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
  await sql.end();
  await fs.rm(temporary, { recursive: true, force: true });
}
