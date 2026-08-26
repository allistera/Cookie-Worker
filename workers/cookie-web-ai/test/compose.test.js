import { afterEach, describe, expect, test, vi } from 'vitest';
import { generateDraft, handleCompose } from '../src/compose.js';

// api/compose.js shipped without unit tests on Vercel; these pin the ported
// behavior: validation short-circuits, the draft/snippet schema split, and
// the owned-reply-context lookup.

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleCompose validation', () => {
  test.each([
    ['an unknown mode', { mode: 'sonnet', instruction: 'write' }],
    ['a missing instruction', { mode: 'draft' }],
  ])('rejects %s before calling OpenAI or the database', async (_name, body) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const sql = stubSql();

    const response = await handleCompose(sql, USER_ID, body, ENV);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sql.calls).toHaveLength(0);
  });
});

describe('handleCompose draft', () => {
  test('loads owned reply context and returns the generated draft', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output_text: JSON.stringify({ subject: 'Re: Kitchen', text: 'Sounds good.' }),
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const sql = stubSql([
      [
        {
          from_name: 'Builder Ltd',
          from_address: 'builder@example.com',
          subject: 'Kitchen',
          body_text: 'Cabinets Tuesday.',
          sent_at: '2026-07-14T09:00:00.000Z',
        },
      ],
    ]);

    const response = await handleCompose(
      sql,
      USER_ID,
      { instruction: 'agree politely', replyToMessageId: MESSAGE_ID },
      ENV,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      draft: { subject: 'Re: Kitchen', text: 'Sounds good.' },
    });
    expect(sql.calls[0].text).toContain('m.user_id = ?');
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const input = JSON.parse(payload.input[1].content);
    expect(input.reply_context.body).toBe('Cabinets Tuesday.');
    expect(payload.input[0].content).toContain('untrusted data');
  });

  test('answers 502 without leaking details when OpenAI fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const response = await handleCompose(stubSql(), USER_ID, { instruction: 'write' }, ENV);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'AI compose failed' });
  });
});

describe('generateDraft snippet mode', () => {
  test('returns the trigger and template for a valid snippet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({ name: 'Meeting-Recap', text: 'Thanks for meeting!' }),
        }),
      }),
    );

    await expect(
      generateDraft({ instruction: 'recap' }, 'key', 'model', 'snippet'),
    ).resolves.toEqual({
      name: 'meeting-recap',
      text: 'Thanks for meeting!',
    });
  });

  test('rejects a snippet whose trigger is not a hyphenated slug', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output_text: JSON.stringify({ name: 'not a slug!', text: 'Hello' }),
        }),
      }),
    );

    await expect(generateDraft({ instruction: 'x' }, 'key', 'model', 'snippet')).rejects.toThrow(
      /invalid snippet/,
    );
  });
});
