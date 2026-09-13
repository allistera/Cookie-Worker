// Local-only integration checks: no environment-provided database URL is used.
// Setup: create a local PostgreSQL database named cookie_performance, owned
// by the current OS user. All tables live in a disposable, randomly named schema.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { handleList } from '../workers/cookie-web-emails/src/emails.js';
import {
  getDocumentPage,
  getDocumentMetadata,
} from '../workers/cookie-web-tasks/src/documentPages.js';
import { reorderTaskItems } from '../workers/cookie-web-tasks/src/taskItems.js';
import { getTaskPage, getTaskDetail } from '../workers/cookie-web-tasks/src/taskPages.js';
const sql = postgres({
  host: '/var/run/postgresql',
  database: 'cookie_performance',
  max: 1,
  prepare: false,
});
const schema = `performance_${randomUUID().replaceAll('-', '')}`;
const user = '11111111-1111-4111-8111-111111111111';
const url = (params) => new URL(`https://fixture.invalid/?${params}`);
async function pages(handler, query, field, cursorName) {
  let cursor = null;
  const all = [];
  for (let n = 0; n < 20; n++) {
    const response = await handler(
      sql,
      user,
      url(`${query}${cursor ? `&${cursorName}=${encodeURIComponent(cursor)}` : ''}`),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body[field].length <= 100);
    all.push(...body[field]);
    if (!body.nextCursor) return all;
    assert.notEqual(body.nextCursor, cursor);
    cursor = body.nextCursor;
  }
  throw new Error('Pagination did not terminate');
}
try {
  await sql`CREATE SCHEMA ${sql(schema)}`;
  await sql`SET search_path TO ${sql(schema)}`;
  await sql.unsafe(
    await fs.readFile(new URL('../test/fixtures/performance-schema.sql', import.meta.url), 'utf8'),
  );
  await sql.unsafe(
    await fs.readFile(
      new URL('../../Cookie-Web/migrations/0074_performance_indexes.sql', import.meta.url),
      'utf8',
    ),
  );
  await sql.unsafe(
    await fs.readFile(
      new URL('../../Cookie-Web/migrations/0075_document_workspace_revisions.sql', import.meta.url),
      'utf8',
    ),
  );
  const mail = await pages(handleList, 'limit=100', 'emails', 'before');
  assert.equal(mail.length, 205);
  assert.equal(
    new Set(mail.map((row) => row.id)).size,
    205,
    'same-microsecond mail must never disappear between pages',
  );
  // Missing, pending and failed classification must stay hidden; completed
  // rows remain visible and the unread count uses exactly the same gate.
  await sql`DELETE FROM message_ai WHERE message_id = md5('mail-1')::uuid`;
  await sql`UPDATE message_ai SET status = 'pending' WHERE message_id = md5('mail-2')::uuid`;
  await sql`UPDATE message_ai SET status = 'failed' WHERE message_id = md5('mail-3')::uuid`;
  const classified = await pages(handleList, 'limit=100', 'emails', 'before');
  assert.equal(classified.length, 202);
  assert.ok(classified.every((row) => !['Mail 1', 'Mail 2', 'Mail 3'].includes(row.subject)));
  assert.ok(classified.some((row) => row.subject === 'Mail 4'));
  const firstPage = await (await handleList(sql, user, url('limit=100'))).json();
  assert.equal(firstPage.unreadCount, 202);
  const docs = await pages(
    getDocumentPage,
    'folder=root&starred=1&tag=work',
    'documents',
    'before',
  );
  assert.equal(docs.length, 205);
  assert.equal(new Set(docs.map((row) => row.id)).size, 205);
  assert.ok(docs.every((row) => row.folder_id === null && row.tags.includes('work')));
  const folder = await (
    await getDocumentPage(sql, user, url('folder=33333333-3333-4333-8333-333333333333'))
  ).json();
  assert.equal(folder.documents.length, 1);
  const metadata = await (await getDocumentMetadata(sql, user, url(''))).json();
  assert.equal(metadata.counts.total, 206);
  assert.deepEqual(metadata.tags, [
    { name: 'folder', count: 1 },
    { name: 'work', count: 205 },
  ]);
  assert.equal(
    (await (await getDocumentMetadata(sql, user, url(`version=${metadata.version}`))).json())
      .unchanged,
    true,
  );
  await sql`DELETE FROM documents WHERE id = '44444444-4444-4444-8444-444444444444'`;
  const changed = await (
    await getDocumentMetadata(sql, user, url(`version=${metadata.version}`))
  ).json();
  assert.equal(changed.counts.total, 205);
  assert.notEqual(
    changed.version,
    metadata.version,
    'deletions must invalidate workspace metadata',
  );
  const tasks = await pages(getTaskPage, 'project=inbox', 'items', 'after');
  assert.equal(tasks.length, 205);
  assert.equal(new Set(tasks.map((row) => row.id)).size, 205);
  assert.ok(tasks.every((row) => row.summary && row.description.length === 240));
  const today = await pages(getTaskPage, 'project=today&date=2026-01-01', 'items', 'after');
  assert.deepEqual(
    today.map((row) => row.id),
    tasks.map((row) => row.id),
  );
  await sql`UPDATE task_items SET today_position = position WHERE parent_id IS NULL`;
  const reorderIds = tasks
    .slice(100, 103)
    .map((row) => row.id)
    .reverse();
  const reordered = await (
    await reorderTaskItems(sql, user, { ids: reorderIds, view: 'today', paged: true })
  ).json();
  assert.equal(reordered.items.length, 3);
  assert.equal(
    (await sql`SELECT today_position FROM task_items WHERE id = ${tasks[0].id}`)[0].today_position,
    1,
  );
  assert.ok(reordered.items.every((row) => Number.isFinite(row.todayPosition)));
  const [{ id: parentId }] = await sql`SELECT id FROM task_items WHERE content = 'Task 1'`;
  const children = await pages(getTaskDetail, `id=${parentId}`, 'subtasks', 'after');
  assert.equal(children.length, 205);
  const detail = await (await getTaskDetail(sql, user, url(`id=${parentId}`))).json();
  assert.equal(detail.item.description.length, 1100);
  assert.equal(detail.counts.total, 205);
  for (const handler of [getDocumentPage, getTaskPage]) {
    assert.equal((await handler(sql, user, url('after=broken&before=broken'))).status, 400);
  }
  assert.equal(
    (await getTaskDetail(sql, '22222222-2222-4222-8222-222222222222', url(`id=${parentId}`)))
      .status,
    404,
  );
  console.log(
    'PostgreSQL integration passed: cursor precision, ownership, workspace revalidation, bounded document/task pages and full task details.',
  );
} finally {
  await sql`DROP SCHEMA ${sql(schema)} CASCADE`;
  await sql.end();
}
