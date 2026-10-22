import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { handleAsk } from '../src/ask.js';
import { createMockSql } from './helpers.js';

const env = { OPENAI_API_KEY: 'test-key' };
const row = {
  id: 'message',
  from_address: 'sender@example.com',
  subject: 'Meeting',
  body_text: 'Tomorrow',
  sent_at: '2026-10-21',
};
const deps = { hybridSearch: async () => [{ id: row.id }] };
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function ask(response, stream = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  return handleAsk(
    createMockSql([[{ allowed: true }], [row]]),
    'owner',
    { question: 'When?' },
    env,
    deps,
    stream,
  );
}

/** @param {Response} response */
async function events(response) {
  return (await response.text())
    .trim()
    .split('\n\n')
    .map((line) => JSON.parse(line.slice(6)));
}

describe('assistant response transport', () => {
  test('streams sources, parsed tokens and completion across split input chunks', async () => {
    const encoder = new TextEncoder();
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          for (const part of [
            ': keepalive\ndata: invalid json\ndata: {"choices":[{"delta":{"content":"Tom',
            'orrow"}}]}\ndata: {}\ndata: {"choices":[{"delta":{}}]}\n',
            'data: [DONE]\n',
          ])
            controller.enqueue(encoder.encode(part));
          controller.close();
        },
      }),
    );
    const response = await ask(upstream);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(await events(response)).toEqual([
      {
        type: 'sources',
        sources: [{ id: row.id, subject: row.subject, from_name: row.from_address }],
      },
      { type: 'token', text: 'Tomorrow' },
      { type: 'done' },
    ]);
  });

  test('streams a useful empty-results answer without contacting the model', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleAsk(
      createMockSql([[{ allowed: true }]]),
      'owner',
      { question: 'When?' },
      env,
      { hybridSearch: async () => [] },
      true,
    );
    expect(await events(response)).toEqual([
      { type: 'sources', sources: [] },
      {
        type: 'token',
        text: "I couldn't find any emails related to that. Try rephrasing your question.",
      },
      { type: 'done' },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects a successful upstream response with no stream body', async () => {
    const response = await ask(new Response(null));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Assistant stream unavailable' });
  });

  test('propagates an interrupted upstream stream instead of reporting completion', async () => {
    const error = new Error('upstream disconnected');
    const response = await ask(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(error);
          },
        }),
      ),
    );
    await expect(response.text()).rejects.toThrow('upstream disconnected');
  });

  test('returns a server error on model HTTP failure', async () => {
    const response = await ask(new Response('Unavailable', { status: 503 }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Ask failed' });
  });

  test.each([
    {},
    { choices: [] },
    { choices: [{ message: {} }] },
    { choices: [{ message: { content: '   ' } }] },
  ])('provides a fallback for an empty completion %j', async (body) => {
    const response = await ask(Response.json(body), false);
    expect((await response.json()).answer).toBe("I couldn't produce an answer.");
  });

  test('bounds and structures untrusted email context and preserves retrieval order', async () => {
    const sql = createMockSql([
      [{ allowed: true }],
      [row, { id: 'second', from_name: 'Sender', subject: '', body_text: 'x'.repeat(1600) }],
    ]);
    const fetchMock = vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      expect(request).toMatchObject({ model: 'custom-model', stream: false, max_tokens: 400 });
      const context = JSON.parse(request.messages[1].content);
      expect(context.question).toBe('When?');
      expect(context.retrieved_emails.map((email) => email.from)).toEqual([
        'Sender',
        row.from_address,
      ]);
      expect(context.retrieved_emails[0]).toMatchObject({
        index: 1,
        subject: '(none)',
        body: 'x'.repeat(1500),
      });
      return Response.json({ choices: [{ message: { content: ' Tomorrow ' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleAsk(
      sql,
      'owner',
      { question: ' When? ' },
      { ...env, OPENAI_ASK_MODEL: 'custom-model' },
      { hybridSearch: async () => [{ id: 'second' }, { id: 'missing' }, { id: row.id }] },
    );
    const body = await response.json();
    expect(body.answer).toBe('Tomorrow');
    expect(body.sources.map((source) => source.id)).toEqual(['second', row.id]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
