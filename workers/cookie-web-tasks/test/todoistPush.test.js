import { describe, expect, it, vi } from 'vitest';
import { encryptToken } from '../../../shared/token-crypto.js';
import { TODOIST_API_URL, TodoistApiError } from '../src/todoistApi.js';
import {
  MAX_PUSHES_PER_RUN,
  pushPendingCompletions,
  pushTaskCompletion,
} from '../src/todoistPush.js';
import { createMockSql } from './helpers.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i + 1)));

/** @param {number} status */
const answer = (status) => new Response(null, { status });

describe('pushPendingCompletions', () => {
  it('closes and reopens the pending tasks in Todoist, oldest first, and clears each one sent', async () => {
    const sql = createMockSql([
      [
        { id: TASK_ID, todoistId: 'td-1', action: 'close' },
        { id: OTHER_ID, todoistId: 'td 2', action: 'reopen' },
      ],
    ]);
    const fetchImpl = vi.fn(async () => answer(204));

    const pushed = await pushPendingCompletions(sql, USER_ID, 'tok', {
      fetchImpl: /** @type {any} */ (fetchImpl),
    });

    expect(pushed).toBe(2);
    // Read, send and clear run under the caller's push lock, so an
    // overlapping push waits and then finds these changes already cleared.
    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(sql.controlCalls).toEqual([
      {
        text: expect.stringContaining('pg_advisory_xact_lock(hashtextextended('),
        values: [USER_ID],
      },
    ]);
    expect(sql.calls[0].text).toContain('todoist_pending IS NOT NULL AND todoist_id IS NOT NULL');
    expect(sql.calls[0].text).toContain('ORDER BY updated_at');
    // Every pending row of the caller, capped per run.
    expect(sql.calls[0].values).toEqual([USER_ID, null, null, MAX_PUSHES_PER_RUN]);
    const requests = /** @type {any[][]} */ (fetchImpl.mock.calls);
    expect(requests.map(([url, init]) => [String(url), init.method])).toEqual([
      [`${TODOIST_API_URL}/tasks/td-1/close`, 'POST'],
      [`${TODOIST_API_URL}/tasks/td%202/reopen`, 'POST'],
    ]);
    expect(requests[0][1].headers.Authorization).toBe('Bearer tok');
    // Each clear names the change that was sent, so a newer one survives.
    expect(sql.calls[1].text).toContain('SET todoist_pending = NULL');
    expect(sql.calls[1].values).toEqual([USER_ID, TASK_ID, 'close']);
    expect(sql.calls[2].values).toEqual([USER_ID, OTHER_ID, 'reopen']);
  });

  it('narrows the read to one task when given its id', async () => {
    const sql = createMockSql([[]]);
    const fetchImpl = vi.fn();

    const pushed = await pushPendingCompletions(sql, USER_ID, 'tok', {
      taskId: TASK_ID,
      fetchImpl: /** @type {any} */ (fetchImpl),
    });

    expect(pushed).toBe(0);
    expect(sql.calls[0].values).toEqual([USER_ID, TASK_ID, TASK_ID, MAX_PUSHES_PER_RUN]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('clears a change Todoist refuses for good without counting it', async () => {
    const sql = createMockSql([[{ id: TASK_ID, todoistId: 'gone', action: 'close' }]]);
    const fetchImpl = vi.fn(async () => answer(404));

    const pushed = await pushPendingCompletions(sql, USER_ID, 'tok', {
      fetchImpl: /** @type {any} */ (fetchImpl),
    });

    expect(pushed).toBe(0);
    expect(sql.calls[1].text).toContain('SET todoist_pending = NULL');
  });

  it('stops at a failure worth another go, leaving that change and the rest pending', async () => {
    const sql = createMockSql([
      [
        { id: TASK_ID, todoistId: 'td-1', action: 'close' },
        { id: OTHER_ID, todoistId: 'td-2', action: 'close' },
      ],
    ]);
    const fetchImpl = vi.fn(async () => answer(503));

    await expect(
      pushPendingCompletions(sql, USER_ID, 'tok', { fetchImpl: /** @type {any} */ (fetchImpl) }),
    ).rejects.toBeInstanceOf(TodoistApiError);

    // Sent once, never retried: a second close would skip an occurrence.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sql.calls).toHaveLength(1);
  });

  it('keeps the clear of a change Todoist took when a later one fails', async () => {
    const sql = createMockSql([
      [
        { id: TASK_ID, todoistId: 'td-1', action: 'close' },
        { id: OTHER_ID, todoistId: 'td-2', action: 'close' },
      ],
    ]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(answer(204)).mockResolvedValueOnce(answer(503));
    // The transaction must commit rather than roll the first clear back, or
    // that close is sent again and a repeating task skips an occurrence.
    let committed = false;
    sql.begin = vi.fn(async (/** @type {(tx: any) => unknown} */ callback) => {
      const result = await callback(sql);
      committed = true;
      return result;
    });

    await expect(
      pushPendingCompletions(sql, USER_ID, 'tok', { fetchImpl: /** @type {any} */ (fetchImpl) }),
    ).rejects.toBeInstanceOf(TodoistApiError);

    expect(committed).toBe(true);
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[1].values).toEqual([USER_ID, TASK_ID, 'close']);
  });
});

describe('pushTaskCompletion', () => {
  it('sends the one task with the connection token', async () => {
    const sql = createMockSql([
      [{ apiTokenEncrypted: await encryptToken('secret-token', KEY), syncTasks: true }],
      [{ id: TASK_ID, todoistId: 'td-1', action: 'close' }],
    ]);
    const fetchImpl = vi.fn(async () => answer(204));

    await pushTaskCompletion(sql, { TODOIST_TOKEN_ENCRYPTION_KEY: KEY }, USER_ID, TASK_ID, {
      fetchImpl: /** @type {any} */ (fetchImpl),
    });

    expect(sql.calls[0].text).toContain('FROM todoist_connections');
    expect(sql.calls[1].values).toEqual([USER_ID, TASK_ID, TASK_ID, MAX_PUSHES_PER_RUN]);
    const [[, init]] = /** @type {any[][]} */ (fetchImpl.mock.calls);
    expect(init.headers.Authorization).toBe('Bearer secret-token');
    expect(sql.calls[2].text).toContain('SET todoist_pending = NULL');
  });

  it('does nothing without the encryption key, a connection, or with tasks switched off', async () => {
    const fetchImpl = vi.fn();
    const deps = { fetchImpl: /** @type {any} */ (fetchImpl) };

    const unconfigured = createMockSql([]);
    await pushTaskCompletion(unconfigured, {}, USER_ID, TASK_ID, deps);
    expect(unconfigured.calls).toHaveLength(0);

    const disconnected = createMockSql([[]]);
    await pushTaskCompletion(
      disconnected,
      { TODOIST_TOKEN_ENCRYPTION_KEY: KEY },
      USER_ID,
      TASK_ID,
      deps,
    );
    expect(disconnected.calls).toHaveLength(1);

    const tasksOff = createMockSql([
      [{ apiTokenEncrypted: await encryptToken('secret-token', KEY), syncTasks: false }],
    ]);
    await pushTaskCompletion(
      tasksOff,
      { TODOIST_TOKEN_ENCRYPTION_KEY: KEY },
      USER_ID,
      TASK_ID,
      deps,
    );
    expect(tasksOff.calls).toHaveLength(1);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws: a failed send leaves the change pending for the next sync', async () => {
    const sql = createMockSql([
      [{ apiTokenEncrypted: await encryptToken('secret-token', KEY), syncTasks: true }],
      [{ id: TASK_ID, todoistId: 'td-1', action: 'close' }],
    ]);
    const fetchImpl = vi.fn(async () => answer(500));

    await expect(
      pushTaskCompletion(sql, { TODOIST_TOKEN_ENCRYPTION_KEY: KEY }, USER_ID, TASK_ID, {
        fetchImpl: /** @type {any} */ (fetchImpl),
      }),
    ).resolves.toBeUndefined();

    expect(sql.calls.some((call) => call.text.includes('SET todoist_pending = NULL'))).toBe(false);
  });
});
