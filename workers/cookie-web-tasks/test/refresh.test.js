import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnricherNotConfiguredError, postRefresh, triggerDigestRebuild } from '../src/refresh.js';
import { createMockSql } from './helpers.js';

const RUN_URL = 'https://data-enricher.example.workers.dev/run';
const TOKEN = 'trigger-secret';
const USER_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('triggerDigestRebuild', () => {
  it('asks the Worker for both AI Today cards, with the bearer secret', async () => {
    await triggerDigestRebuild(RUN_URL, TOKEN);

    const [url, init] = /** @type {any} */ (fetch).mock.calls[0];
    expect(url.toString()).toBe(`${RUN_URL}?phase=today`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('throws a typed error when the trigger is not configured', async () => {
    await expect(triggerDigestRebuild(undefined, undefined)).rejects.toBeInstanceOf(
      EnricherNotConfiguredError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws when the Worker rejects the trigger', async () => {
    vi.mocked(fetch).mockResolvedValue(/** @type {any} */ ({ ok: false, status: 401 }));
    await expect(triggerDigestRebuild(RUN_URL, TOKEN)).rejects.toThrow('Enricher responded 401');
  });
});

describe('postRefresh', () => {
  it('returns 200 once the digest has been rebuilt', async () => {
    const sql = createMockSql([[{ allowed: true }]]);
    const response = await postRefresh(sql, USER_ID, RUN_URL, TOKEN);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('returns 501 when no enricher is wired up', async () => {
    const sql = createMockSql([[{ allowed: true }]]);
    const response = await postRefresh(sql, USER_ID, undefined, undefined);
    expect(response.status).toBe(501);
    expect((await response.json()).error).toMatch(/not configured/);
  });

  it('returns 502 when the Worker fails', async () => {
    vi.mocked(fetch).mockResolvedValue(/** @type {any} */ ({ ok: false, status: 500 }));
    const sql = createMockSql([[{ allowed: true }]]);
    const response = await postRefresh(sql, USER_ID, RUN_URL, TOKEN);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('500');
  });

  it('returns 503 when the rate-limit check itself fails', async () => {
    const sql = /** @type {any} */ (vi.fn(() => Promise.reject(new Error('connection reset'))));
    const response = await postRefresh(sql, USER_ID, RUN_URL, TOKEN);
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('429s when the caller is rate-limited', async () => {
    const sql = createMockSql([[{ allowed: false }]]);
    const response = await postRefresh(sql, USER_ID, RUN_URL, TOKEN);
    expect(response.status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });
});
