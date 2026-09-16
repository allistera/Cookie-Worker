import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildDigest,
  fetchDigestMessages,
  pruneDigest,
  repairDigest,
  DIGEST_MAX_OUTPUT_TOKENS,
  DIGEST_REASONING_EFFORT,
  DIGEST_PROMPT_VERSION,
  TRIAGE_POLICY_SOURCE,
  UNCLASSIFIED_NOTE,
} from '../src/digest.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const MESSAGES = [
  {
    id: 'msg-1',
    from_name: 'City Construction',
    from_address: 'updates@cityconstruction.com',
    envelope_to: 'home@example.com',
    subject: 'Revised Floor Plan',
    gist: 'Please approve the revised design by tomorrow.',
    sent_at: '2026-08-17T08:00:00.000Z',
  },
  {
    id: 'msg-2',
    from_name: null,
    from_address: 'claims@insurer.example',
    envelope_to: 'finance@example.com',
    subject: 'Claim processed',
    gist: 'Your homeowner claim was processed.',
    sent_at: '2026-08-17T07:00:00.000Z',
  },
  {
    id: 'msg-3',
    from_name: 'Shop',
    from_address: 'offers@shop.example',
    envelope_to: 'shopping@example.com',
    subject: 'Weekend sale',
    gist: 'Save 20 percent this weekend.',
    sent_at: '2026-08-17T06:00:00.000Z',
  },
];

const TRIAGE = {
  overview: 'One reply, one item to review, and one promotion hidden.',
  reply_needed: [
    {
      message_id: 'msg-1',
      headline: 'Approve the revised floor plan',
      note: 'The contractor needs a decision by tomorrow.',
      suggested_action: 'Reply with approval or requested changes',
    },
  ],
  review: [
    {
      message_id: 'msg-2',
      headline: 'Insurance claim processed',
      note: 'Check the final claim outcome.',
    },
  ],
  noise: [{ message_id: 'msg-3', category: 'promotional' }],
};

describe('buildDigest email triage', () => {
  test('requests structured three-tier triage and converts it for the AI Inbox', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(TRIAGE) }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(buildDigest(MESSAGES, 'key', 'gpt-5.6-luna')).resolves.toEqual({
      overview: TRIAGE.overview,
      topics: [
        {
          emoji: '↩️',
          title: 'Reply Needed',
          items: [
            {
              message_id: 'msg-1',
              headline: 'Approve the revised floor plan',
              note: 'The contractor needs a decision by tomorrow. Suggested: Reply with approval or requested changes.',
            },
          ],
        },
        {
          emoji: '👀',
          title: 'Review',
          items: [
            {
              message_id: 'msg-2',
              headline: 'Insurance claim processed',
              note: 'Check the final claim outcome.',
            },
          ],
        },
      ],
      noise: { count: 1, categories: [{ category: 'promotional', count: 1 }] },
    });

    const [url, init] = /** @type {[string, {headers: Record<string, string>, body: string}]} */ (
      /** @type {unknown} */ (fetchMock.mock.calls[0])
    );
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.max_output_tokens).toBe(DIGEST_MAX_OUTPUT_TOKENS);
    expect(body.reasoning).toEqual({ effort: DIGEST_REASONING_EFFORT });
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'email_triage' });
    expect(body.input[0].content).toContain('Reply Needed, Review, and Noise');
    expect(body.input[1].content).toContain('home@example.com');
    expect(body.input[1].content).toContain('msg-1');
  });

  test('omits the reasoning option for models that do not support it', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(TRIAGE) }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(buildDigest(MESSAGES, 'key', 'gpt-4.1-nano')).resolves.toMatchObject({
      overview: TRIAGE.overview,
    });

    const [, init] = /** @type {[string, {headers: Record<string, string>, body: string}]} */ (
      /** @type {unknown} */ (fetchMock.mock.calls[0])
    );
    const body = JSON.parse(init.body);
    expect(body.reasoning).toBeUndefined();
    expect(body.max_output_tokens).toBe(DIGEST_MAX_OUTPUT_TOKENS);
  });

  test('throws on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429 })),
    );
    await expect(buildDigest(MESSAGES, 'key', 'gpt-5.6-luna')).rejects.toThrow(
      'OpenAI request failed (429)',
    );
  });

  test('retries once after bad coverage and returns the valid result', async () => {
    const incomplete = {
      ...TRIAGE,
      noise: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ output_text: JSON.stringify(incomplete) }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ output_text: JSON.stringify(TRIAGE) }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(buildDigest(MESSAGES, 'key', 'gpt-5.6-luna')).resolves.toEqual({
      overview: TRIAGE.overview,
      topics: [
        {
          emoji: '↩️',
          title: 'Reply Needed',
          items: [
            {
              message_id: 'msg-1',
              headline: 'Approve the revised floor plan',
              note: 'The contractor needs a decision by tomorrow. Suggested: Reply with approval or requested changes.',
            },
          ],
        },
        {
          emoji: '👀',
          title: 'Review',
          items: [
            {
              message_id: 'msg-2',
              headline: 'Insurance claim processed',
              note: 'Check the final claim outcome.',
            },
          ],
        },
      ],
      noise: { count: 1, categories: [{ category: 'promotional', count: 1 }] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('retries once after incomplete model output', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ output_text: JSON.stringify(TRIAGE) }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(buildDigest(MESSAGES, 'key', 'gpt-5-nano')).resolves.toMatchObject({
      overview: TRIAGE.overview,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('retries once after an aborted model request', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ output_text: JSON.stringify(TRIAGE) }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(buildDigest(MESSAGES, 'key', 'gpt-5-nano')).resolves.toMatchObject({
      overview: TRIAGE.overview,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('repairs the last response after both attempts have bad coverage', async () => {
    const incomplete = {
      ...TRIAGE,
      noise: [],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(incomplete) }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await buildDigest(MESSAGES, 'key', 'gpt-5.6-luna');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.topics.flatMap((topic) => topic.items).map((item) => item.message_id)).toEqual([
      'msg-1',
      'msg-2',
      'msg-3',
    ]);
    expect(result.topics[1].items[1]).toEqual({
      message_id: 'msg-3',
      headline: 'Weekend sale',
      note: UNCLASSIFIED_NOTE,
    });
    expect(result.noise).toEqual({ count: 0, categories: [] });
  });

  test('records the adapted policy and prompt version for provenance', () => {
    expect(TRIAGE_POLICY_SOURCE).toBe('ericporres/email-triage-plugin');
    expect(DIGEST_PROMPT_VERSION).toMatch(/^email-triage-v/);
  });
});

describe('pruneDigest triage validation', () => {
  const known = new Set(['a', 'b', 'c']);

  test('shows reply and review items but summarizes noise as category counts', () => {
    const result = pruneDigest(
      {
        overview: 'Triage complete.',
        reply_needed: [
          { message_id: 'a', headline: 'A', note: 'Needs a reply.', suggested_action: 'Reply' },
        ],
        review: [{ message_id: 'b', headline: 'B', note: 'Read this.' }],
        noise: [{ message_id: 'c', category: 'marketing' }],
      },
      known,
    );

    expect(result.topics.map((topic) => topic.title)).toEqual(['Reply Needed', 'Review']);
    expect(result.topics.flatMap((topic) => topic.items).map((item) => item.message_id)).toEqual([
      'a',
      'b',
    ]);
    expect(result.noise).toEqual({ count: 1, categories: [{ category: 'marketing', count: 1 }] });
  });

  test.each([
    [
      'omits an input',
      { reply_needed: [], review: [], noise: [{ message_id: 'a', category: 'other' }] },
    ],
    [
      'repeats an input',
      {
        reply_needed: [{ message_id: 'a', headline: 'A', note: 'n', suggested_action: 'Reply' }],
        review: [{ message_id: 'a', headline: 'A again', note: 'n' }],
        noise: [
          { message_id: 'b', category: 'other' },
          { message_id: 'c', category: 'other' },
        ],
      },
    ],
    [
      'invents an input',
      {
        reply_needed: [],
        review: [{ message_id: 'a', headline: 'A', note: 'n' }],
        noise: [
          { message_id: 'b', category: 'other' },
          { message_id: 'c', category: 'other' },
          { message_id: 'invented', category: 'other' },
        ],
      },
    ],
  ])('rejects model output that %s', (_label, payload) => {
    expect(() => pruneDigest({ overview: '', ...payload }, known)).toThrow(
      'Email triage did not classify every message exactly once',
    );
  });
});

describe('repairDigest triage coverage', () => {
  const resultIds = (result) =>
    result.topics.flatMap((topic) => topic.items).map((item) => item.message_id);

  test('moves an omitted id into Review', () => {
    const result = repairDigest(
      {
        overview: '',
        reply_needed: [
          { message_id: 'msg-1', headline: 'A', note: 'n', suggested_action: 'Reply' },
        ],
        review: [{ message_id: 'msg-2', headline: 'B', note: 'n' }],
        noise: [],
      },
      MESSAGES,
    );

    expect(resultIds(result)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(result.topics[1].items[1]).toMatchObject({
      message_id: 'msg-3',
      note: UNCLASSIFIED_NOTE,
    });
    expect(result.noise.count + resultIds(result).length).toBe(MESSAGES.length);
  });

  test('keeps the first occurrence when an id is repeated', () => {
    const result = repairDigest(
      {
        overview: '',
        reply_needed: [
          { message_id: 'msg-1', headline: 'First', note: 'n', suggested_action: 'Reply' },
        ],
        review: [
          { message_id: 'msg-1', headline: 'Duplicate', note: 'n' },
          { message_id: 'msg-2', headline: 'B', note: 'n' },
        ],
        noise: [{ message_id: 'msg-3', category: 'other' }],
      },
      MESSAGES,
    );

    expect(resultIds(result)).toEqual(['msg-1', 'msg-2']);
    expect(result.topics[0].items[0].headline).toBe('First');
    expect(result.noise.count + resultIds(result).length).toBe(MESSAGES.length);
  });

  test('drops an invented id', () => {
    const result = repairDigest(
      {
        overview: '',
        reply_needed: [
          { message_id: 'msg-1', headline: 'A', note: 'n', suggested_action: 'Reply' },
        ],
        review: [{ message_id: 'msg-2', headline: 'B', note: 'n' }],
        noise: [
          { message_id: 'msg-3', category: 'other' },
          { message_id: 'invented', category: 'other' },
        ],
      },
      MESSAGES,
    );

    expect(resultIds(result)).toEqual(['msg-1', 'msg-2']);
    expect(result.noise).toEqual({ count: 1, categories: [{ category: 'other', count: 1 }] });
    expect(result.noise.count + resultIds(result).length).toBe(MESSAGES.length);
  });
});

describe('fetchDigestMessages', () => {
  test('selects the last 24 hours of inbox mail regardless of read state', async () => {
    const calls = [];
    const sql = (strings, ...values) => {
      calls.push({ text: strings.join('$'), values });
      return Promise.resolve(MESSAGES);
    };
    const rows = await fetchDigestMessages(/** @type {any} */ (sql), 'user-1');
    expect(rows).toEqual(MESSAGES);

    const { text, values } = calls[0];
    expect(text).not.toContain('messages.is_unread');
    expect(text).toContain("interval '1 day'");
    expect(text).toContain('messages.envelope_to');
    expect(text).toContain('messages.scheduled_for IS NULL');
    expect(text).toContain('NOT messages.is_sent');
    expect(text).toContain('NOT messages.is_archived');
    expect(text).toContain('NOT messages.is_deleted');
    expect(text).toContain("spam_verdict, 'inbox') <> 'spam'");
    expect(values).toContain('user-1');
  });
});
