import { describe, expect, it } from 'vitest';

import {
  cleanTaskFilters,
  getTaskFilters,
  loadTaskFilter,
  putTaskFilters,
  taskFilterSql,
} from '../src/taskFilters.js';
import { getTaskPage } from '../src/taskPages.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-9999-9999-999999999999';
const FILTER_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const DATE = '2026-10-14';

const FILTER = /** @type {import('../src/taskFilters.js').TaskFilter} */ ({
  id: FILTER_ID,
  name: 'Urgent this week',
  match: 'all',
  rules: [
    { field: 'due', value: 'week', negate: false },
    { field: 'priority', value: 1, negate: false },
  ],
});

/**
 * getTaskPage and taskFilterSql compose nested sql`` fragments. Here a
 * fragment resolves to a plain object; the user prefs read and the final
 * LIMIT 101 query are the only ones that answer with rows.
 *
 * @param {unknown[]} rows
 * @param {unknown[]} [users]
 */
function createFragmentSql(rows = [], users = []) {
  /** @type {{text: string, values: unknown[]}[]} */
  const calls = [];
  const sql = (/** @type {TemplateStringsArray} */ strings, /** @type {unknown[]} */ ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('LIMIT 101')) return Promise.resolve(rows);
    if (text.includes('FROM users')) return Promise.resolve(users);
    return { text, values };
  };
  sql.json = (/** @type {unknown} */ value) => ({ __json: value });
  sql.calls = calls;
  return /** @type {any} */ (sql);
}

/**
 * Flattens a nested fragment to one SQL text with its parameters in order,
 * the way the driver would render it.
 *
 * @param {any} fragment
 */
function render(fragment) {
  /** @type {unknown[]} */
  const params = [];
  /** @param {any} node */
  const walk = (node) => {
    const parts = node.text.split('?');
    let out = parts[0];
    node.values.forEach((/** @type {any} */ value, /** @type {number} */ index) => {
      if (value && typeof value === 'object' && 'text' in value) out += walk(value);
      else {
        params.push(value);
        out += '?';
      }
      out += parts[index + 1];
    });
    return out;
  };
  return { text: walk(fragment), params };
}

/** @param {string} project @param {string | null} [date] */
function pageUrl(project, date = DATE) {
  const url = new URL(
    `https://tasks.example/task-items?view=page&project=${encodeURIComponent(project)}`,
  );
  if (date) url.searchParams.set('date', date);
  return url;
}

describe('cleanTaskFilters', () => {
  it('accepts a document and normalises each rule', () => {
    const result = cleanTaskFilters({
      revision: 3,
      filters: [
        {
          ...FILTER,
          rules: [
            { field: 'label', value: '@Home' },
            { field: 'project', value: PROJECT_ID.toUpperCase(), negate: true },
            { field: 'project', value: 'inbox' },
            { field: 'priority', value: 2, negate: false },
            { field: 'due', value: 'overdue' },
          ],
        },
      ],
    });

    expect(result).toEqual({
      revision: 3,
      filters: [
        {
          id: FILTER_ID,
          name: 'Urgent this week',
          match: 'all',
          rules: [
            { field: 'label', value: 'home', negate: false },
            { field: 'project', value: PROJECT_ID, negate: true },
            { field: 'project', value: 'inbox', negate: false },
            { field: 'priority', value: 2, negate: false },
            { field: 'due', value: 'overdue', negate: false },
          ],
        },
      ],
    });
  });

  it('drops any extra fields a client sends along', () => {
    const result = cleanTaskFilters({
      revision: 0,
      filters: [{ ...FILTER, colour: 'red', rules: [{ field: 'due', value: 'any', note: 'x' }] }],
    });
    expect(result).toEqual({
      revision: 0,
      filters: [
        {
          id: FILTER_ID,
          name: FILTER.name,
          match: 'all',
          rules: [{ field: 'due', value: 'any', negate: false }],
        },
      ],
    });
  });

  it.each([
    [null, 'Invalid saved-filter document.'],
    [{ revision: -1, filters: [] }, 'Invalid saved-filter revision.'],
    [{ revision: 0, filters: 'nope' }, 'Save at most 30 filters.'],
    [
      { revision: 0, filters: Array.from({ length: 31 }, () => FILTER) },
      'Save at most 30 filters.',
    ],
    [{ revision: 0, filters: [FILTER, FILTER] }, 'Each saved filter needs a unique ID.'],
    [{ revision: 0, filters: [{ ...FILTER, id: 'abc' }] }, 'Each saved filter needs a unique ID.'],
    [
      { revision: 0, filters: [{ ...FILTER, name: ' padded ' }] },
      'Filter names must be 1–60 characters without control characters.',
    ],
    [
      { revision: 0, filters: [{ ...FILTER, name: 'a\u0007b' }] },
      'Filter names must be 1–60 characters without control characters.',
    ],
    [
      {
        revision: 0,
        filters: [FILTER, { ...FILTER, id: PROJECT_ID, name: 'URGENT THIS WEEK' }],
      },
      'Saved-filter names must be unique.',
    ],
    [
      { revision: 0, filters: [{ ...FILTER, match: 'some' }] },
      'Choose whether a filter matches all or any of its rules.',
    ],
    [{ revision: 0, filters: [{ ...FILTER, rules: [] }] }, 'A filter needs 1–10 rules.'],
    [
      {
        revision: 0,
        filters: [{ ...FILTER, rules: Array.from({ length: 11 }, () => FILTER.rules[0]) }],
      },
      'A filter needs 1–10 rules.',
    ],
    [
      { revision: 0, filters: [{ ...FILTER, rules: [{ field: 'assignee', value: 'me' }] }] },
      'Each rule filters by due date, project, priority or label.',
    ],
    [
      { revision: 0, filters: [{ ...FILTER, rules: [{ field: 'due', value: 'yesterday' }] }] },
      'A due date rule needs overdue, today, tomorrow, week, none or any.',
    ],
    [
      { revision: 0, filters: [{ ...FILTER, rules: [{ field: 'project', value: 'Work' }] }] },
      'A project rule needs a project id or inbox.',
    ],
    [
      { revision: 0, filters: [{ ...FILTER, rules: [{ field: 'priority', value: '2' }] }] },
      'A priority rule needs a priority from 1 to 4.',
    ],
    [
      { revision: 0, filters: [{ ...FILTER, rules: [{ field: 'priority', value: 5 }] }] },
      'A priority rule needs a priority from 1 to 4.',
    ],
    [
      { revision: 0, filters: [{ ...FILTER, rules: [{ field: 'label', value: 'two words' }] }] },
      'A label rule needs a label name without spaces, @, or #.',
    ],
    [
      {
        revision: 0,
        filters: [{ ...FILTER, rules: [{ field: 'due', value: 'today', negate: 'yes' }] }],
      },
      'A rule either includes or excludes; negate must be true or false.',
    ],
  ])('refuses %j', (body, error) => {
    expect(cleanTaskFilters(body)).toEqual({ error });
  });
});

describe('GET /task-filters', () => {
  it('returns the stored document', async () => {
    const stored = { revision: 2, filters: [FILTER] };
    const sql = createMockSql([[{ filters: stored }]]);

    const response = await getTaskFilters(sql, USER_ID);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual(stored);
    expect(sql.calls[0].text).toContain("prefs -> 'savedTaskFilters'");
    expect(sql.calls[0].values).toEqual([USER_ID]);
  });

  it('reads an empty list at revision 0 when nothing was ever saved', async () => {
    const sql = createMockSql([[{ filters: null }]]);
    expect(await (await getTaskFilters(sql, USER_ID)).json()).toEqual({
      revision: 0,
      filters: [],
    });
  });

  it('404s an unknown caller', async () => {
    const sql = createMockSql([[]]);
    expect((await getTaskFilters(sql, USER_ID)).status).toBe(404);
  });
});

describe('PUT /task-filters', () => {
  it('replaces the document at the given revision and returns the saved one', async () => {
    const saved = { revision: 3, filters: [FILTER] };
    const sql = createMockSql([[{ filters: saved }]]);

    const response = await putTaskFilters(sql, USER_ID, { revision: 2, filters: [FILTER] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(saved);
    expect(sql.calls[0].text).toContain(
      "jsonb_set(coalesce(prefs, '{}'::jsonb), '{savedTaskFilters}'",
    );
    expect(sql.calls[0].values).toEqual([{ __json: saved }, USER_ID, '2']);
  });

  it('409s with the current document when another session saved first', async () => {
    const current = { revision: 5, filters: [] };
    const sql = createMockSql([[], [{ filters: current }]]);

    const response = await putTaskFilters(sql, USER_ID, { revision: 2, filters: [FILTER] });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Saved filters changed in another session',
      current,
    });
  });

  it('400s an invalid document without touching the database', async () => {
    const sql = createMockSql([]);
    const response = await putTaskFilters(sql, USER_ID, { revision: 0, filters: [null] });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Invalid saved filter.');
    expect(sql.calls).toHaveLength(0);
  });
});

describe('loadTaskFilter', () => {
  it('finds the caller filter by id', async () => {
    const sql = createMockSql([[{ filters: { revision: 1, filters: [FILTER] } }]]);
    expect(await loadTaskFilter(sql, USER_ID, FILTER_ID)).toEqual(FILTER);
    expect(await loadTaskFilter(sql, USER_ID, PROJECT_ID)).toBeNull();
  });
});

describe('taskFilterSql', () => {
  const sql = createFragmentSql();

  it('joins every rule with AND for an all filter', () => {
    expect(render(taskFilterSql(sql, FILTER, DATE))).toEqual({
      text: '(COALESCE(t.due_date >= ?::date AND t.due_date < ?::date + 7, false) AND t.priority = ?)',
      params: [DATE, DATE, 1],
    });
  });

  it('joins with OR for an any filter and wraps an excluding rule in NOT', () => {
    const filter = /** @type {import('../src/taskFilters.js').TaskFilter} */ ({
      ...FILTER,
      match: 'any',
      rules: [
        { field: 'label', value: 'home', negate: false },
        { field: 'project', value: 'inbox', negate: true },
        { field: 'project', value: PROJECT_ID, negate: false },
      ],
    });
    expect(render(taskFilterSql(sql, filter, DATE))).toEqual({
      text: '(t.labels @> ARRAY[?]::text[] OR NOT (t.project_id IS NULL) OR t.project_id = ?::uuid)',
      params: ['home', PROJECT_ID],
    });
  });

  it.each([
    ['overdue', 'COALESCE(t.due_date < ?::date, false)', [DATE]],
    ['today', 'COALESCE(t.due_date = ?::date, false)', [DATE]],
    ['tomorrow', 'COALESCE(t.due_date = ?::date + 1, false)', [DATE]],
    ['none', 't.due_date IS NULL', []],
    ['any', 't.due_date IS NOT NULL', []],
  ])('writes the %s due rule so an undated task answers false', (value, text, params) => {
    const filter = /** @type {any} */ ({
      ...FILTER,
      rules: [{ field: 'due', value, negate: false }],
    });
    expect(render(taskFilterSql(sql, filter, DATE))).toEqual({ text: `(${text})`, params });
  });

  it('matches nothing when a stored filter somehow has no rules', () => {
    expect(render(taskFilterSql(sql, { ...FILTER, rules: [] }, DATE))).toEqual({
      text: 'false',
      params: [],
    });
  });
});

describe('GET /task-items?view=page with a filter', () => {
  const prefs = [{ filters: { revision: 1, filters: [FILTER] } }];

  it('lists open tasks the filter fits, by due date with undated rows last', async () => {
    const sql = createFragmentSql(
      [{ id: 't1', dueDate: DATE, position: 1, cursor_time: 'x' }],
      prefs,
    );

    const response = await getTaskPage(sql, USER_ID, pageUrl(`filter:${FILTER_ID}`));

    expect(response.status).toBe(200);
    expect((await response.json()).items).toHaveLength(1);
    const query = render(sql.calls.find((call) => call.text.includes('LIMIT 101')));
    expect(query.text).toContain("AND t.kind = 'task' AND (COALESCE(t.due_date >= ?::date");
    expect(query.text).toContain("ORDER BY COALESCE(t.due_date, DATE '9999-12-31'), 0::float8");
    expect(query.text).toContain('t.completed_at IS NULL');
    expect(query.params).toEqual([USER_ID, DATE, DATE, 1]);
    expect(sql.calls[0].text).toContain('FROM users');
    expect(sql.calls[0].values).toEqual([USER_ID]);
  });

  it('cursors past an undated last row with the sentinel date', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: `t${index}`,
      dueDate: null,
      position: index,
      cursor_time: '2026-01-01T00:00:00.000000Z',
    }));
    const sql = createFragmentSql(rows, prefs);

    const body = await (await getTaskPage(sql, USER_ID, pageUrl(`filter:${FILTER_ID}`))).json();

    expect(body.items).toHaveLength(100);
    expect(JSON.parse(atob(body.nextCursor.replaceAll('-', '+').replaceAll('_', '/')))).toEqual([
      '9999-12-31',
      0,
      99,
      '2026-01-01T00:00:00.000000Z',
      't99',
    ]);
  });

  it('rejects a filter id that could never exist', async () => {
    const sql = createFragmentSql([], prefs);
    expect((await getTaskPage(sql, USER_ID, pageUrl('filter:nonsense'))).status).toBe(400);
    expect(sql.calls).toHaveLength(0);
  });

  it('needs the caller date, as Today does', async () => {
    const sql = createFragmentSql([], prefs);
    const response = await getTaskPage(sql, USER_ID, pageUrl(`filter:${FILTER_ID}`, null));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Invalid date');
  });

  it('404s a filter the caller does not have', async () => {
    const sql = createFragmentSql([], prefs);
    const response = await getTaskPage(sql, USER_ID, pageUrl(`filter:${PROJECT_ID}`));
    expect(response.status).toBe(404);
    expect(sql.calls.some((call) => call.text.includes('LIMIT 101'))).toBe(false);
  });
});
