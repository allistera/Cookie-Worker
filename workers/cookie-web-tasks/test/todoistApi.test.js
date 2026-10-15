import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PAGES,
  PAGE_SIZE,
  TODOIST_API_URL,
  TodoistApiError,
  TodoistAuthError,
  fetchAccount,
  fetchSnapshot,
  listAll,
} from '../src/todoistApi.js';

/** @param {unknown} body @param {number} [status] */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('listAll', () => {
  it('follows next_cursor and sends the bearer token on every page', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: '1' }], next_cursor: 'abc' }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: '2' }], next_cursor: null }));

    const rows = await listAll('tok', '/projects', { fetchImpl: /** @type {any} */ (fetchImpl) });

    expect(rows).toEqual([{ id: '1' }, { id: '2' }]);
    const [first, second] = fetchImpl.mock.calls.map(([url, init]) => ({
      url: new URL(String(url)),
      init,
    }));
    expect(first.url.origin + first.url.pathname).toBe(`${TODOIST_API_URL}/projects`);
    expect(first.url.searchParams.get('limit')).toBe(String(PAGE_SIZE));
    expect(first.url.searchParams.has('cursor')).toBe(false);
    expect(first.init.headers.Authorization).toBe('Bearer tok');
    expect(second.url.searchParams.get('cursor')).toBe('abc');
  });

  it('reads the completed list under its own key', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ items: [{ id: '9' }], next_cursor: null }));
    const rows = await listAll('tok', '/tasks/completed/by_completion_date', {
      key: 'items',
      query: { since: '2026-09-01T00:00:00.000Z' },
      fetchImpl: /** @type {any} */ (fetchImpl),
    });
    expect(rows).toEqual([{ id: '9' }]);
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('since')).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  it('turns 401 and 403 into TodoistAuthError and other failures into TodoistApiError', async () => {
    const unauthorized = vi.fn().mockResolvedValue(jsonResponse({ error: 'no' }, 401));
    await expect(
      listAll('tok', '/tasks', { fetchImpl: /** @type {any} */ (unauthorized) }),
    ).rejects.toBeInstanceOf(TodoistAuthError);

    const forbidden = vi.fn().mockResolvedValue(jsonResponse({ error: 'no' }, 403));
    await expect(
      listAll('tok', '/tasks', { fetchImpl: /** @type {any} */ (forbidden) }),
    ).rejects.toBeInstanceOf(TodoistAuthError);

    const broken = vi.fn().mockResolvedValue(jsonResponse({ error: 'down' }, 503));
    const error = await listAll('tok', '/tasks', {
      fetchImpl: /** @type {any} */ (broken),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(TodoistApiError);
    expect(error).not.toBeInstanceOf(TodoistAuthError);
    expect(error.status).toBe(503);
  });

  it('refuses a body without the expected array and a cursor that never ends', async () => {
    const odd = vi.fn().mockResolvedValue(jsonResponse({ nope: true }));
    await expect(
      listAll('tok', '/tasks', { fetchImpl: /** @type {any} */ (odd) }),
    ).rejects.toBeInstanceOf(TodoistApiError);

    const endless = vi.fn(async () => jsonResponse({ results: [], next_cursor: 'again' }));
    await expect(
      listAll('tok', '/tasks', { fetchImpl: /** @type {any} */ (endless) }),
    ).rejects.toThrow('too many pages');
    expect(endless).toHaveBeenCalledTimes(MAX_PAGES);
  });
});

describe('fetchAccount', () => {
  it('returns the email and time zone, or nulls when Todoist gives none', async () => {
    const full = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ email: ' person@example.com ', tz_info: { timezone: 'Europe/Paris' } }),
      );
    expect(await fetchAccount('tok', /** @type {any} */ (full))).toEqual({
      email: 'person@example.com',
      timeZone: 'Europe/Paris',
    });
    const bare = vi.fn().mockResolvedValue(jsonResponse({ id: '1' }));
    expect(await fetchAccount('tok', /** @type {any} */ (bare))).toEqual({
      email: null,
      timeZone: null,
    });
  });
});

describe('fetchSnapshot', () => {
  it('reads projects, sections, tasks and the completed window in that order', async () => {
    const fetchImpl = vi.fn(async (/** @type {any} */ url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/by_completion_date')) {
        return jsonResponse({ items: [{ id: 'done' }], next_cursor: null });
      }
      return jsonResponse({ results: [{ id: path }], next_cursor: null });
    });
    const snapshot = await fetchSnapshot('tok', {
      completedSince: new Date('2026-09-01T00:00:00Z'),
      completedUntil: new Date('2026-10-01T00:00:00Z'),
      fetchImpl: /** @type {any} */ (fetchImpl),
    });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/v1/projects',
      '/api/v1/sections',
      '/api/v1/tasks',
      '/api/v1/tasks/completed/by_completion_date',
    ]);
    expect(snapshot.completed).toEqual([{ id: 'done' }]);
    expect(snapshot.tasks).toEqual([{ id: '/api/v1/tasks' }]);
  });
});
