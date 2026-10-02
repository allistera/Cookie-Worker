import { describe, expect, it } from 'vitest';
import { getTaskDetail, getTaskPage } from '../src/taskPages.js';

const USER_ID = '99999999-9999-9999-9999-999999999999';

/**
 * getTaskPage composes nested sql`` fragments, which createMockSql would
 * consume from its FIFO queue. Here a fragment resolves to a plain object
 * and only the final query — the one carrying LIMIT 101 — returns rows.
 *
 * @param {unknown[]} rows
 */
function createFragmentSql(rows) {
  /** @type {{text: string, values: unknown[]}[]} */
  const calls = [];
  const sql = (/** @type {TemplateStringsArray} */ strings, /** @type {unknown[]} */ ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    return text.includes('LIMIT 101') ? Promise.resolve(rows) : { text, values };
  };
  sql.calls = calls;
  return /** @type {any} */ (sql);
}

/** @param {string} project */
function pageUrl(project) {
  return new URL(
    `https://tasks.example/task-items?view=page&project=${encodeURIComponent(project)}`,
  );
}

describe('GET /task-items?view=page with a label', () => {
  it('filters by label containment and orders like a project list', async () => {
    const sql = createFragmentSql([{ id: 't1', labels: ['home'], position: 1, cursor_time: 'x' }]);

    const response = await getTaskPage(sql, USER_ID, pageUrl('label:Home'));

    expect(response.status).toBe(200);
    expect((await response.json()).items).toHaveLength(1);
    const filter = sql.calls.find((call) => call.text.includes('labels @> ARRAY[?]::text[]'));
    expect(filter.values).toEqual(['home']);
    expect(sql.calls.some((call) => call.text.includes('project_id ='))).toBe(false);
  });

  it('rejects a label name that could never exist', async () => {
    const sql = createFragmentSql([]);
    const response = await getTaskPage(sql, USER_ID, pageUrl('label:two words'));
    expect(response.status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('still refuses an unknown project value', async () => {
    const response = await getTaskPage(createFragmentSql([]), USER_ID, pageUrl('nonsense'));
    expect(response.status).toBe(400);
  });
});

describe('GET /task-items?view=detail', () => {
  const TASK_ID = '11111111-1111-1111-1111-111111111111';
  const detailUrl = new URL(`https://tasks.example/task-items?view=detail&id=${TASK_ID}`);

  /**
   * Fragments resolve to plain objects; each top-level query (one reading
   * FROM task_items) waits until the test releases it, so the test can see
   * which queries were issued before any of them answered.
   *
   * @param {unknown[][]} results in query order
   */
  function createHeldSql(results) {
    /** @type {string[]} */
    const issued = [];
    /** @type {(() => void)[]} */
    const release = [];
    const sql = (
      /** @type {TemplateStringsArray} */ strings,
      /** @type {unknown[]} */ ...values
    ) => {
      const text = strings.join('?');
      if (!text.includes('FROM task_items')) return { text, values };
      const result = results[issued.length];
      issued.push(text);
      return new Promise((resolve) => release.push(() => resolve(result)));
    };
    return { sql: /** @type {any} */ (sql), issued, release };
  }

  it('issues the task, sub-task and count reads together', async () => {
    const { sql, issued, release } = createHeldSql([
      [{ id: TASK_ID, cursor_time: 'x' }],
      [{ id: 'sub', position: 1, cursor_time: 'y' }],
      [{ total: 1, done: 0 }],
    ]);

    const pending = getTaskDetail(sql, USER_ID, detailUrl);
    await Promise.resolve();

    expect(issued).toHaveLength(3);
    expect(issued[0]).toContain('t.id = ?');
    expect(issued[1]).toContain('t.parent_id = ?');
    expect(issued[2]).toContain('count(*)');
    for (const done of release) done();
    const response = await pending;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.item).toEqual({ id: TASK_ID, summary: false });
    expect(body.subtasks).toEqual([{ id: 'sub', position: 1 }]);
    expect(body.counts).toEqual({ total: 1, done: 0 });
    expect(body.nextCursor).toBeNull();
  });

  it('404s a task the caller does not own', async () => {
    const { sql, release } = createHeldSql([[], [], [{ total: 0, done: 0 }]]);
    const pending = getTaskDetail(sql, USER_ID, detailUrl);
    await Promise.resolve();
    for (const done of release) done();
    expect((await pending).status).toBe(404);
  });
});
