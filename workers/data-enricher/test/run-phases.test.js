import { beforeEach, describe, expect, test, vi } from 'vitest';

// The phases are stubbed at the module boundary so the routing can be asserted
// without a database, an MCP server or OpenAI.
vi.mock('postgres', () => ({
  default: () => {
    const sql = () => Promise.resolve([]);
    sql.end = vi.fn(async () => undefined);
    return sql;
  },
}));
vi.mock('../src/mcp.js', () => ({
  connectMcp: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
}));
vi.mock('../src/todoist.js', () => ({
  gatherTodoistTasks: vi.fn(async () => []),
}));
vi.mock('../src/analyze.js', () => ({
  fetchImportantMessages: vi.fn(async () => []),
  analyzeEmail: vi.fn(),
}));
vi.mock('../src/digest.js', () => ({
  fetchDigestMessages: vi.fn(async () => [{ id: 'msg-1' }]),
  buildDigest: vi.fn(async () => ({ overview: 'o', topics: [] })),
  DIGEST_KIND: 'daily_digest',
  DIGEST_PROMPT_VERSION: 'daily-digest-v1',
}));
vi.mock('../src/store.js', () => ({
  lookupUserId: vi.fn(async () => 'user-1'),
  storeTasks: vi.fn(async () => 0),
  storeSummary: vi.fn(async () => undefined),
  storeDigest: vi.fn(async () => 'digest-1'),
}));

import worker from '../src/worker.js';
import { gatherTodoistTasks } from '../src/todoist.js';
import { fetchImportantMessages } from '../src/analyze.js';
import { buildDigest } from '../src/digest.js';
import { storeDigest } from '../src/store.js';

const TOKEN = 'test-trigger-token';
const env = /** @type {any} */ ({
  HTTP_TRIGGER_TOKEN: TOKEN,
  HYPERDRIVE: { connectionString: 'postgres://stub' },
  OWNER_EMAIL: 'owner@example.com',
  OPENAI_API_KEY: 'key',
  AI_MODEL: 'gpt-5.6-luna',
  TODOIST_MCP_URL: 'https://ai.todoist.net/mcp',
});
const ctx = /** @type {any} */ ({});

function run(query = '') {
  return worker.fetch(
    new Request(`https://data-enricher.example.workers.dev/run${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    }),
    env,
    ctx,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /run phase routing', () => {
  test('runs every phase when no phase is given', async () => {
    const response = await run();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', phase: 'all' });
    expect(gatherTodoistTasks).toHaveBeenCalled();
    expect(fetchImportantMessages).toHaveBeenCalled();
    expect(storeDigest).toHaveBeenCalled();
  });

  // The refresh button must not re-gather Todoist or re-analyse ten emails.
  test('runs only the digest for ?phase=digest', async () => {
    const response = await run('?phase=digest');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', phase: 'digest' });
    expect(buildDigest).toHaveBeenCalled();
    expect(storeDigest).toHaveBeenCalled();
    expect(gatherTodoistTasks).not.toHaveBeenCalled();
    expect(fetchImportantMessages).not.toHaveBeenCalled();
  });

  test('rejects an unknown phase without running anything', async () => {
    const response = await run('?phase=everything');

    expect(response.status).toBe(400);
    expect(storeDigest).not.toHaveBeenCalled();
    expect(gatherTodoistTasks).not.toHaveBeenCalled();
  });

  test('reports a generic failure when a phase throws', async () => {
    vi.mocked(buildDigest).mockRejectedValueOnce(new Error('openai exploded'));

    const response = await run('?phase=digest');

    expect(response.status).toBe(500);
    // The body must not leak the underlying error.
    await expect(response.json()).resolves.toEqual({ status: 'failed' });
  });
});
