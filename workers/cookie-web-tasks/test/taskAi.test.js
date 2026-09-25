import { beforeEach, describe, expect, it, vi } from 'vitest';

const { allowRequestMock } = vi.hoisted(() => ({ allowRequestMock: vi.fn() }));

vi.mock('../../../shared/rate-limit.js', () => ({ allowRequest: allowRequestMock }));

import {
  createAiTask,
  normalizeTaskPlan,
  extractTaskTokens,
  generateTaskDraft,
  interpretTask,
  normalizeTaskDraft,
} from '../src/taskAi.js';
import { createTaskTree } from '../src/taskItems.js';
import { createMockSql } from './helpers.js';

const USER_ID = '99999999-9999-9999-9999-999999999999';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  allowRequestMock.mockReset().mockResolvedValue(true);
});

describe('task quick-add tokens', () => {
  it('extracts exact priority, project, and label shortcuts', () => {
    expect(extractTaskTokens('Call plumber Friday 3pm p1 #Work @Home @home')).toEqual({
      text: 'Call plumber Friday 3pm',
      priority: 1,
      projectName: 'Work',
      labels: ['home'],
    });
  });

  it('supports quoted project names', () => {
    expect(extractTaskTokens('Plan launch #"Side Hustle"')).toMatchObject({
      text: 'Plan launch',
      projectName: 'Side Hustle',
    });
  });

  it('rejects conflicting priority and project shortcuts', () => {
    expect(() => extractTaskTokens('Book flight p1 p2')).toThrow('Choose one priority');
    expect(() => extractTaskTokens('Book flight #Work #Personal')).toThrow('Choose one #project');
  });
});

describe('AI task draft normalization', () => {
  it('normalizes optional fields and supported recurrence', () => {
    expect(
      normalizeTaskDraft(
        {
          content: ' Water plants ',
          description: '',
          dueDate: '2026-09-07',
          dueTime: '09:30',
          recurrence: 'Every Monday',
        },
        'Europe/London',
      ),
    ).toEqual({
      content: 'Water plants',
      description: null,
      dueDate: '2026-09-07',
      dueTime: '09:30',
      timeZone: 'Europe/London',
      recurrence: 'every monday',
    });
  });

  it('rejects impossible dates and unsupported schedules', () => {
    const base = { content: 'Task', description: '', dueTime: '', recurrence: '' };
    expect(() => normalizeTaskDraft({ ...base, dueDate: '2026-02-31' }, 'UTC')).toThrow(
      'Invalid task date',
    );
    expect(() =>
      normalizeTaskDraft({ ...base, dueDate: '', recurrence: 'every blue moon' }, 'UTC'),
    ).toThrow('Unsupported repeat schedule');
  });
});

describe('OpenAI task draft generation', () => {
  it('uses the Responses API structured-output contract and normalizes the result', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              content: 'Call plumber',
              description: '',
              dueDate: '2026-09-11',
              dueTime: '15:00',
              recurrence: '',
            }),
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    );

    const result = await generateTaskDraft(
      { text: 'Call plumber Friday 3pm', now: '2026-09-05T12:00:00.000Z', timeZone: 'UTC' },
      'test-key',
      fetchMock,
    );

    expect(result).toMatchObject({
      content: 'Call plumber',
      dueDate: '2026-09-11',
      dueTime: '15:00',
      timeZone: 'UTC',
    });
    const [endpoint, options] = /** @type {any[][]} */ (fetchMock.mock.calls)[0];
    const request = JSON.parse(options.body);
    expect(endpoint).toBe('https://api.openai.com/v1/responses');
    expect(request.store).toBe(false);
    expect(request.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(options.headers.Authorization).toBe('Bearer test-key');
  });
});

describe('POST /task-items/interpret', () => {
  it('combines an AI draft with exact shortcuts and the owned project match', async () => {
    const sql = createMockSql([[{ id: PROJECT_ID }]]);
    const generator = vi.fn(async ({ text, timeZone }) => ({
      content: 'Call plumber',
      description: null,
      dueDate: '2026-09-11',
      dueTime: '15:00',
      timeZone,
      recurrence: null,
      source: text,
    }));

    const response = await interpretTask(
      sql,
      USER_ID,
      { text: 'Call plumber Friday 3pm p1 #Work @home', timeZone: 'Europe/London' },
      { OPENAI_API_KEY: 'test-key' },
      { generator, now: () => new Date('2026-09-05T12:00:00.000Z') },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      draft: {
        content: 'Call plumber',
        projectId: PROJECT_ID,
        priority: 1,
        labels: ['home'],
      },
    });
    expect(generator).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Call plumber Friday 3pm', timeZone: 'Europe/London' }),
      'test-key',
    );
  });

  it('refuses an unknown project without calling OpenAI', async () => {
    const generator = vi.fn();
    const response = await interpretTask(
      createMockSql([[]]),
      USER_ID,
      { text: 'Call plumber #Unknown', timeZone: 'UTC' },
      { OPENAI_API_KEY: 'test-key' },
      { generator },
    );

    expect(response.status).toBe(400);
    expect(generator).not.toHaveBeenCalled();
  });

  it('returns a useful fallback when the key is unavailable', async () => {
    const response = await interpretTask(
      createMockSql([]),
      USER_ID,
      { text: 'Call plumber Friday', timeZone: 'UTC' },
      {},
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Advanced'),
    });
  });

  it('rate-limits before calling the provider', async () => {
    allowRequestMock.mockResolvedValue(false);
    const generator = vi.fn();
    const response = await interpretTask(
      createMockSql([]),
      USER_ID,
      { text: 'Call plumber Friday', timeZone: 'UTC' },
      { OPENAI_API_KEY: 'test-key' },
      { generator },
    );

    expect(response.status).toBe(429);
    expect(generator).not.toHaveBeenCalled();
  });

  it('does not expose provider failures', async () => {
    const response = await interpretTask(
      createMockSql([]),
      USER_ID,
      { text: 'Call plumber Friday', timeZone: 'UTC' },
      { OPENAI_API_KEY: 'test-key' },
      { generator: vi.fn(async () => Promise.reject(new Error('private provider detail'))) },
    );

    expect(response.status).toBe(502);
    expect((await response.json()).error).not.toContain('private provider detail');
  });
});

describe('AI task plans', () => {
  it('validates and trims the whole plan, allowing simple tasks without subtasks', () => {
    expect(normalizeTaskPlan({ content: ' Buy milk ', description: '', subtasks: [] })).toEqual({
      content: 'Buy milk',
      description: null,
      subtasks: [],
    });
    for (const subtasks of [
      null,
      Array(9).fill({ content: 'Step', description: '' }),
      [{ content: '', description: '' }],
    ]) {
      expect(() =>
        normalizeTaskPlan({ content: 'Plan trip', description: '', subtasks }),
      ).toThrow();
    }
  });

  it('generates a structured plan with meaningful subtasks', async () => {
    const value = {
      content: 'Plan a day trip to London',
      description: 'Arrange travel and an itinerary.',
      subtasks: [{ content: 'Choose a date', description: 'Check availability.' }],
    };
    const fetchMock = vi.fn(async () => Response.json({ output_text: JSON.stringify(value) }));
    expect(
      await generateTaskDraft(
        { text: 'Plan day trip to london', now: '2026-09-11', timeZone: 'UTC', expand: true },
        'test-key',
        fetchMock,
      ),
    ).toEqual(value);
    const request = JSON.parse(/** @type {any} */ (fetchMock.mock.calls[0])[1].body);
    expect(request.text.format.schema.required).toContain('subtasks');
    expect(request.text.format.schema.properties.subtasks.maxItems).toBe(8);
  });

  it('saves parent and children in one locked transaction with owned parent links', async () => {
    const parent = { id: PROJECT_ID, kind: 'task', projectId: null, content: 'Plan trip' };
    const child = { id: USER_ID, parentId: PROJECT_ID, content: 'Choose date' };
    const sql = createMockSql([[parent], [parent], [child]]);
    const response = await createTaskTree(
      sql,
      USER_ID,
      {
        content: 'Plan trip',
        description: 'Arrange travel',
        subtasks: [{ content: 'Choose date', description: '' }],
      },
      {},
    );
    expect(response.status).toBe(201);
    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(sql.controlCalls).toHaveLength(1);
    expect(sql.calls[1].values).toEqual([PROJECT_ID, USER_ID]);
    await expect(response.json()).resolves.toEqual({ item: parent, subtasks: [child] });
  });

  it('throws inside the transaction when a child cannot be saved', async () => {
    const sql = createMockSql([[{ id: PROJECT_ID }], []]);
    await expect(
      createTaskTree(sql, USER_ID, { content: 'Plan trip', subtasks: [{ content: 'Step' }] }, {}),
    ).rejects.toThrow('Could not save generated task');
    expect(sql.begin).toHaveBeenCalledTimes(1);
  });

  it('refuses invalid input and rate-limited generation before any task writes', async () => {
    const sql = createMockSql([]);
    expect(
      (
        await createAiTask(
          sql,
          USER_ID,
          { text: ' ', timeZone: 'UTC' },
          { OPENAI_API_KEY: 'test-key' },
        )
      ).status,
    ).toBe(400);
    allowRequestMock.mockResolvedValue(false);
    expect(
      (
        await createAiTask(
          sql,
          USER_ID,
          { text: 'Plan trip', timeZone: 'UTC' },
          { OPENAI_API_KEY: 'test-key' },
        )
      ).status,
    ).toBe(429);
    expect(sql.begin).not.toHaveBeenCalled();
  });
});
