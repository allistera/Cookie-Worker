import { describe, expect, it } from 'vitest';
import { getTaskPage } from '../src/taskPages.js';

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
