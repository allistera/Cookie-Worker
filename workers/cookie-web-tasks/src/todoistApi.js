// The Todoist REST API (unified v1) as the sync needs it: the signed-in
// account, and every page of projects, sections, active tasks and recently
// completed tasks. Read-only — nothing here writes to Todoist.
//
// Every list endpoint pages the same way (`cursor` in, `next_cursor` out,
// `limit` at most 200); listAll walks the pages so callers see one array.
// The completed-tasks endpoint keys its array `items` rather than `results`,
// hence the `key` parameter. A 401 or 403 is a TodoistAuthError so the sync
// can mark the connection as needing a new token rather than retrying it
// every hour; everything else is a TodoistApiError carrying the status.

import { fetchWithTimeout, readTextCapped } from '../../../shared/fetch.js';

export const TODOIST_API_URL = 'https://api.todoist.com/api/v1';
export const PAGE_SIZE = 200;
// Pages are capped so a runaway cursor can never loop forever: 50 pages of
// 200 is ten thousand rows per list, far beyond a personal account.
export const MAX_PAGES = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export class TodoistApiError extends Error {
  /** @param {number} status @param {string} path */
  constructor(status, path) {
    super(`Todoist responded ${status} for ${path}`);
    this.name = 'TodoistApiError';
    this.status = status;
  }
}

export class TodoistAuthError extends TodoistApiError {
  /** @param {number} status @param {string} path */
  constructor(status, path) {
    super(status, path);
    this.name = 'TodoistAuthError';
  }
}

/**
 * @param {string} token
 * @param {string} path Absolute API path such as `/tasks`.
 * @param {Record<string, string>} query
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<any>}
 */
async function getJson(token, path, query, fetchImpl) {
  const url = new URL(`${TODOIST_API_URL}${path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return fetchWithTimeout(
    url,
    { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    async (response) => {
      if (response.status === 401 || response.status === 403) {
        throw new TodoistAuthError(response.status, path);
      }
      if (!response.ok) throw new TodoistApiError(response.status, path);
      const text = await readTextCapped(response, MAX_BODY_BYTES);
      try {
        return JSON.parse(text);
      } catch {
        throw new TodoistApiError(response.status, path);
      }
    },
    REQUEST_TIMEOUT_MS,
    fetchImpl,
  );
}

/**
 * Every row of a paginated list.
 *
 * @param {string} token
 * @param {string} path
 * @param {{query?: Record<string, string>, key?: string, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<any[]>}
 */
export async function listAll(
  token,
  path,
  { query = {}, key = 'results', fetchImpl = fetch } = {},
) {
  /** @type {any[]} */
  const rows = [];
  /** @type {string | null} */
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await getJson(
      token,
      path,
      { ...query, limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) },
      fetchImpl,
    );
    const items = body?.[key];
    if (!Array.isArray(items)) throw new TodoistApiError(200, path);
    rows.push(...items);
    cursor = typeof body.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
    if (!cursor) return rows;
  }
  throw new TodoistApiError(200, `${path} (too many pages)`);
}

/**
 * The account the token belongs to. Used when a token is saved: a rejected
 * token fails here, before anything is stored, and the email and time zone
 * come back for Settings and the sync schedule.
 *
 * @param {string} token
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{id: string | null, email: string | null, timeZone: string | null}>}
 */
export async function fetchAccount(token, fetchImpl = fetch) {
  const user = await getJson(token, '/user', {}, fetchImpl);
  const id =
    typeof user?.id === 'string' || typeof user?.id === 'number'
      ? String(user.id).slice(0, 64)
      : '';
  const email = typeof user?.email === 'string' ? user.email.trim().slice(0, 320) : '';
  const timeZone =
    typeof user?.tz_info?.timezone === 'string' ? user.tz_info.timezone.trim().slice(0, 100) : '';
  return { id: id || null, email: email || null, timeZone: timeZone || null };
}

/**
 * Everything one sync run reads, fetched in sequence so a personal token
 * never fires four requests at once at Todoist's per-user rate limit.
 *
 * @param {string} token
 * @param {{completedSince: Date, completedUntil: Date, fetchImpl?: typeof fetch}} options
 */
export async function fetchSnapshot(token, { completedSince, completedUntil, fetchImpl = fetch }) {
  const projects = await listAll(token, '/projects', { fetchImpl });
  const sections = await listAll(token, '/sections', { fetchImpl });
  const tasks = await listAll(token, '/tasks', { fetchImpl });
  const completed = await listAll(token, '/tasks/completed/by_completion_date', {
    key: 'items',
    query: { since: completedSince.toISOString(), until: completedUntil.toISOString() },
    fetchImpl,
  });
  return { projects, sections, tasks, completed };
}
