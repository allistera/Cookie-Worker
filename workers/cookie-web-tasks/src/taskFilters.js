// Saved task filters for the Tasks app: a named set of rules on due date,
// project, priority and labels, matched as all or any, each rule negatable,
// listing the tasks it fits across every project. The whole list is kept in
// users.prefs under one key with a revision, the way cookie-web-search keeps
// saved mail views: GET returns the document, PUT replaces it at the revision
// it was read at and answers 409 with the current document when another
// session saved first. No table of its own — a person keeps a handful of
// these, and they are only ever read back whole.
//
// A list view asks for `project=filter:<id>`; taskPages.js reads the one
// filter back (loadTaskFilter) and turns it into a WHERE fragment
// (taskFilterSql) against the caller's own date. The prefs key is
// savedTaskFilters, written as a literal below so Postgres never has to
// infer a parameter's type inside jsonb_set's path.

import { validId } from '../../../shared/pagination.js';
import { cleanLabelName } from './taskLabels.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
const MAX_FILTERS = 30;
const MAX_RULES = 10;
const MAX_NAME_LENGTH = 60;
const FIELDS = ['due', 'project', 'priority', 'label'];
const DUE_VALUES = ['overdue', 'today', 'tomorrow', 'week', 'none', 'any'];
const MATCHES = ['all', 'any'];

/**
 * @typedef {{field: 'due' | 'project' | 'priority' | 'label', value: string | number, negate: boolean}} TaskFilterRule
 * @typedef {{id: string, name: string, match: 'all' | 'any', rules: TaskFilterRule[]}} TaskFilter
 */

/**
 * One rule as it will be stored, or a user-facing reason it cannot be.
 *
 * @param {unknown} rule
 * @returns {{rule: TaskFilterRule} | {error: string}}
 */
function cleanRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return { error: 'Each rule needs a field and a value.' };
  }
  const { field, value, negate } = /** @type {Record<string, unknown>} */ (rule);
  if (typeof field !== 'string' || !FIELDS.includes(field)) {
    return { error: 'Each rule filters by due date, project, priority or label.' };
  }
  if (negate !== undefined && typeof negate !== 'boolean') {
    return { error: 'A rule either includes or excludes; negate must be true or false.' };
  }
  /** @type {string | number | null} */
  let clean = null;
  if (field === 'due') {
    clean = typeof value === 'string' && DUE_VALUES.includes(value) ? value : null;
    if (clean === null) {
      return {
        error: 'A due date rule needs overdue, today, tomorrow, week, none or any.',
      };
    }
  } else if (field === 'project') {
    if (value === 'inbox') clean = 'inbox';
    else if (typeof value === 'string' && validId(value)) clean = value.toLowerCase();
    if (clean === null) return { error: 'A project rule needs a project id or inbox.' };
  } else if (field === 'priority') {
    clean =
      typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4
        ? value
        : null;
    if (clean === null) return { error: 'A priority rule needs a priority from 1 to 4.' };
  } else {
    clean = cleanLabelName(value);
    if (clean === null) {
      return { error: 'A label rule needs a label name without spaces, @, or #.' };
    }
  }
  return {
    rule: {
      field: /** @type {TaskFilterRule['field']} */ (field),
      value: /** @type {string | number} */ (clean),
      negate: negate === true,
    },
  };
}

/**
 * The stored document, however the column reads: a missing or malformed
 * value is an empty list at revision 0.
 *
 * @param {unknown} stored
 * @returns {{revision: number, filters: TaskFilter[]}}
 */
export function parseTaskFilters(stored) {
  const value = /** @type {Record<string, any>} */ (
    stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}
  );
  return {
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    filters: Array.isArray(value.filters) ? value.filters : [],
  };
}

/**
 * Validates a PUT body and returns the filters as they will be stored, or a
 * user-facing reason the body was refused.
 *
 * @param {unknown} body
 * @returns {{revision: number, filters: TaskFilter[]} | {error: string}}
 */
export function cleanTaskFilters(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid saved-filter document.' };
  }
  const value = /** @type {Record<string, any>} */ (body);
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    value.revision >= Number.MAX_SAFE_INTEGER
  ) {
    return { error: 'Invalid saved-filter revision.' };
  }
  if (!Array.isArray(value.filters) || value.filters.length > MAX_FILTERS) {
    return { error: `Save at most ${MAX_FILTERS} filters.` };
  }
  const ids = new Set();
  const names = new Set();
  /** @type {TaskFilter[]} */
  const filters = [];
  for (const filter of value.filters) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
      return { error: 'Invalid saved filter.' };
    }
    if (typeof filter.id !== 'string' || !validId(filter.id) || ids.has(filter.id)) {
      return { error: 'Each saved filter needs a unique ID.' };
    }
    if (
      typeof filter.name !== 'string' ||
      filter.name !== filter.name.trim() ||
      !filter.name ||
      filter.name.length > MAX_NAME_LENGTH ||
      [...filter.name].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)
    ) {
      return {
        error: `Filter names must be 1–${MAX_NAME_LENGTH} characters without control characters.`,
      };
    }
    const normalizedName = filter.name.toLocaleLowerCase();
    if (names.has(normalizedName)) return { error: 'Saved-filter names must be unique.' };
    if (typeof filter.match !== 'string' || !MATCHES.includes(filter.match)) {
      return { error: 'Choose whether a filter matches all or any of its rules.' };
    }
    if (!Array.isArray(filter.rules) || !filter.rules.length || filter.rules.length > MAX_RULES) {
      return { error: `A filter needs 1–${MAX_RULES} rules.` };
    }
    /** @type {TaskFilterRule[]} */
    const rules = [];
    for (const rule of filter.rules) {
      const cleaned = cleanRule(rule);
      if ('error' in cleaned) return cleaned;
      rules.push(cleaned.rule);
    }
    ids.add(filter.id);
    names.add(normalizedName);
    filters.push({ id: filter.id, name: filter.name, match: filter.match, rules });
  }
  return { revision: value.revision, filters };
}

/** @param {import('postgres').Sql} sql @param {string} userId */
export async function getTaskFilters(sql, userId) {
  const [row] =
    await sql`SELECT prefs -> 'savedTaskFilters' AS filters FROM users WHERE id = ${userId}`;
  if (!row) return Response.json({ error: 'User not found' }, { status: 404, headers: NO_STORE });
  return Response.json(parseTaskFilters(row.filters), { headers: NO_STORE });
}

/** @param {import('postgres').Sql} sql @param {string} userId @param {unknown} body */
export async function putTaskFilters(sql, userId, body) {
  const cleaned = cleanTaskFilters(body);
  if ('error' in cleaned) {
    return Response.json({ error: cleaned.error }, { status: 400, headers: NO_STORE });
  }
  const next = { revision: cleaned.revision + 1, filters: cleaned.filters };
  const [saved] = await sql`
    UPDATE users
    SET prefs = jsonb_set(coalesce(prefs, '{}'::jsonb), '{savedTaskFilters}', ${sql.json(next)}, true)
    WHERE id = ${userId}
      AND coalesce(prefs -> 'savedTaskFilters' ->> 'revision', '0') = ${String(cleaned.revision)}
    RETURNING prefs -> 'savedTaskFilters' AS filters
  `;
  if (saved) return Response.json(parseTaskFilters(saved.filters), { headers: NO_STORE });
  const [current] =
    await sql`SELECT prefs -> 'savedTaskFilters' AS filters FROM users WHERE id = ${userId}`;
  if (!current) {
    return Response.json({ error: 'User not found' }, { status: 404, headers: NO_STORE });
  }
  return Response.json(
    {
      error: 'Saved filters changed in another session',
      current: parseTaskFilters(current.filters),
    },
    { status: 409, headers: NO_STORE },
  );
}

/**
 * One of the caller's saved filters, or null when there is no such filter.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string} id
 * @returns {Promise<TaskFilter | null>}
 */
export async function loadTaskFilter(sql, userId, id) {
  const [row] =
    await sql`SELECT prefs -> 'savedTaskFilters' AS filters FROM users WHERE id = ${userId}`;
  const { filters } = parseTaskFilters(row?.filters);
  return filters.find((filter) => filter?.id === id) ?? null;
}

/**
 * The test one rule makes against a task_items row aliased `t`. Date rules
 * are written so a row with no due date answers false rather than null: a
 * task with no date is "not overdue", and a negated rule must say so.
 *
 * @param {import('postgres').Sql} sql
 * @param {TaskFilterRule} rule
 * @param {string} date the caller's own calendar date, YYYY-MM-DD
 */
function ruleSql(sql, rule, date) {
  if (rule.field === 'due') {
    switch (rule.value) {
      case 'overdue':
        return sql`COALESCE(t.due_date < ${date}::date, false)`;
      case 'today':
        return sql`COALESCE(t.due_date = ${date}::date, false)`;
      case 'tomorrow':
        return sql`COALESCE(t.due_date = ${date}::date + 1, false)`;
      case 'week':
        return sql`COALESCE(t.due_date >= ${date}::date AND t.due_date < ${date}::date + 7, false)`;
      case 'none':
        return sql`t.due_date IS NULL`;
      case 'any':
        return sql`t.due_date IS NOT NULL`;
      default:
        return sql`false`;
    }
  }
  if (rule.field === 'project') {
    return rule.value === 'inbox'
      ? sql`t.project_id IS NULL`
      : sql`t.project_id = ${String(rule.value)}::uuid`;
  }
  if (rule.field === 'priority') return sql`t.priority = ${Number(rule.value)}`;
  if (rule.field === 'label') return sql`t.labels @> ARRAY[${String(rule.value)}]::text[]`;
  return sql`false`;
}

/**
 * A parenthesised WHERE fragment for the whole filter: its rules joined with
 * AND or OR, each wrapped in NOT when it excludes. A filter with no rules
 * (which the validator never stores) matches nothing rather than everything.
 *
 * @param {import('postgres').Sql} sql
 * @param {TaskFilter} filter
 * @param {string} date the caller's own calendar date, YYYY-MM-DD
 */
export function taskFilterSql(sql, filter, date) {
  const rules = (Array.isArray(filter.rules) ? filter.rules : []).map((rule) => {
    const test = ruleSql(sql, rule, date);
    return rule.negate ? sql`NOT (${test})` : test;
  });
  if (!rules.length) return sql`false`;
  const joined = rules.reduce((left, right) =>
    filter.match === 'any' ? sql`${left} OR ${right}` : sql`${left} AND ${right}`,
  );
  return sql`(${joined})`;
}
