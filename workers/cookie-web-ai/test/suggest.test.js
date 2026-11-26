import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanSuggestion, handleComposeSuggest } from '../src/suggest.js';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const ENV = { OPENAI_API_KEY: 'test-key' };

/** @param {unknown[][]} results @returns {any} */
function stubSql(results = []) {
  const queue = [...results];
  /** @type {{text: string, values: unknown[]}[]} */
  const calls = [];
  /** @type {any} */
  const sql = (/** @type {TemplateStringsArray} */ strings, /** @type {any[]} */ ...values) => {
    calls.push({ text: strings.join('?'), values });
    return Promise.resolve(queue.length ? queue.shift() : []);
  };
  sql.calls = calls;
  return sql;
}

/** @param {string} completion */
function stubCompletion(completion) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ output_text: JSON.stringify({ completion }) }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cleanSuggestion', () => {
  test.each([
    ['keeps the space that joins a new word', ' your email.', 'Thanks for', ' your email.'],
    [
      'drops the space after text that already ends in one',
      ' your email.',
      'Thanks for ',
      'your email.',
    ],
    ['completes a word without a space', 'ks for your email.', 'Than', 'ks for your email.'],
    ['starts a fresh line without a space', ' Thanks for', 'Hi Sam,\n', 'Thanks for'],
    ['keeps the first line only', ' your email.\nBest,', 'Thanks for', ' your email.'],
    [
      'drops the words the writer already typed',
      'Thanks for your email.',
      'Hi,\nThanks for',
      ' your email.',
    ],
    [
      'drops a repeat that ends at the space',
      'Thanks for your email.',
      'Thanks for ',
      'your email.',
    ],
    ['returns nothing for an empty completion', '', 'Thanks for', ''],
    ['returns nothing for a completion that only repeats', 'Thanks for', 'Thanks for', ''],
  ])('%s', (_name, completion, text, expected) => {
    expect(cleanSuggestion(completion, text)).toBe(expected);
  });

  test('caps a long completion', () => {
    expect(cleanSuggestion(` ${'word '.repeat(60)}`, 'A')).toHaveLength(120);
  });
});

describe('handleComposeSuggest', () => {
  test.each([
    ['missing text', {}],
    ['blank text', { text: ' \n ' }],
  ])('rejects %s before the quota, OpenAI or the database', async (_name, body) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const sql = stubSql();
    const claimQuota = vi.fn(async () => null);

    const response = await handleComposeSuggest(sql, USER_ID, body, ENV, claimQuota);

    expect(response.status).toBe(400);
    expect(claimQuota).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sql.calls).toHaveLength(0);
  });

  test('returns the quota response without calling OpenAI', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const denied = Response.json({ error: 'slow down' }, { status: 429 });

    const response = await handleComposeSuggest(
      stubSql(),
      USER_ID,
      { text: 'Thanks for' },
      ENV,
      async () => denied,
    );

    expect(response).toBe(denied);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('asks for a completion of the text before the caret without a reasoning pass', async () => {
    const fetchMock = stubCompletion(' your email.');

    const response = await handleComposeSuggest(
      stubSql(),
      USER_ID,
      { text: 'Hi Sam,\nThanks for', to: 'sam@example.com', subject: 'Kitchen' },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestion: ' your email.' });
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.model).toBe('gpt-6-luna');
    expect(payload.reasoning).toEqual({ effort: 'none' });
    expect(payload.input[0].content).toContain('untrusted data');
    expect(JSON.parse(payload.input[1].content)).toEqual({
      recipient: 'sam@example.com',
      subject: 'Kitchen',
      reply_context: null,
      text_before_caret: 'Hi Sam,\nThanks for',
    });
  });

  test('sends the end of a long message with its trailing space intact', async () => {
    const fetchMock = stubCompletion('soon.');

    await handleComposeSuggest(
      stubSql(),
      USER_ID,
      { text: `${'a'.repeat(3000)} speak\u00a0` },
      ENV,
    );

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const { text_before_caret: text } = JSON.parse(payload.input[1].content);
    expect(text).toHaveLength(1500);
    expect(text.endsWith(' speak ')).toBe(true);
  });

  test('loads only the owned, allowed message as reply context', async () => {
    const fetchMock = stubCompletion(' works for me.');
    const sql = stubSql([
      [
        {
          from_name: 'Builder Ltd',
          from_address: 'builder@example.com',
          subject: 'Kitchen',
          body_text: `Cabinets Tuesday.${'x'.repeat(5000)}`,
          sent_at: '2026-07-14T09:00:00.000Z',
        },
      ],
    ]);

    await handleComposeSuggest(
      sql,
      USER_ID,
      { text: 'Tuesday', replyToMessageId: MESSAGE_ID },
      ENV,
    );

    expect(sql.calls[0].text).toContain('m.user_id = ?');
    expect(sql.calls[0].text).toContain("m.screening_status = 'allowed'");
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const input = JSON.parse(payload.input[1].content);
    expect(input.reply_context.from).toBe('Builder Ltd');
    expect(input.reply_context.body).toHaveLength(2000);
  });

  test('leaves the reasoning option off a model that does not take it', async () => {
    const fetchMock = stubCompletion(' your email.');

    await handleComposeSuggest(
      stubSql(),
      USER_ID,
      { text: 'Thanks for' },
      { ...ENV, OPENAI_COMPOSE_MODEL: 'gpt-4o-mini' },
    );

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.model).toBe('gpt-4o-mini');
    expect(payload).not.toHaveProperty('reasoning');
  });

  test('answers 502 without leaking details when OpenAI fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const response = await handleComposeSuggest(stubSql(), USER_ID, { text: 'Thanks for' }, ENV);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'AI suggestion failed' });
  });
});
