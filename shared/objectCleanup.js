/**
 * Persist intent before uploading bytes, so even a crash between put and the
 * metadata insert leaves a retryable cleanup pointer. Deletion triggers bring
 * an existing job forward when a registered object is removed. The queue is
 * drained by cookie-web-tasks's hourly cron (its src/objectCleanup.js), which
 * rechecks live references before deleting anything.
 *
 * @param {import('postgres').Sql | import('postgres').TransactionSql} sql
 * @param {'r2' | 'blob'} storage @param {string} key @param {number} [delayHours]
 */
export async function queueObjectCleanup(sql, storage, key, delayHours = 0) {
  await sql`
    INSERT INTO object_cleanup_jobs (storage, object_key, available_at)
    VALUES (${storage}, ${key}, now() + ${delayHours} * interval '1 hour')
    ON CONFLICT (storage, object_key) DO NOTHING
  `;
}
