import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildDigest,
  fetchDigestMessages,
  pruneDigest,
  DIGEST_MAX_TOPICS,
  DIGEST_PROMPT_VERSION,
} from '../src/digest.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const MESSAGES = [
  {
    id: 'msg-1',
    from_name: 'City Construction',
    from_address: 'updates@cityconstruction.com',
    subject: 'Revised Floor Plan',
    gist: 'A revised design accounting for the bay window.',
  },
  {
    id: 'msg-2',
    from_name: null,
    from_address: 'claims@insurer.example',
    subject: 'Claim processed',
    gist: 'Your homeowner claim was processed.',
  },
];

const DIGEST = {
  overview: 'Mostly kitchen renovation news.',
  topics: [
    {
      emoji: '🍳',
      title: 'Kitchen Renovation',
      items: [
        { message_id: 'msg-1', headline: 'Revised Floor Plan', note: 'New design for the bay window.' },
        { message_id: 'msg-2', headline: 'Claim Processed', note: 'Insurer processed the claim.' },
      ],
    },
  ],
};

describe('buildDigest', () => {
  test('requests a structured digest and parses it', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(DIGEST) }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(buildDigest(MESSAGES, 'key', 'gpt-5.6-luna')).resolves.toEqual(DIGEST);

    const [url, init] = /** @type {[string, {headers: Record<string, string>, body: string}]} */ (
      /** @type {unknown} */ (fetchMock.mock.calls[0])
    );
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.text.format.type).toBe('json_schema');
    // The model sees ids, subjects and gists — never raw bodies.
    expect(JSON.stringify(body.input)).toContain('Revised Floor Plan');
    expect(JSON.stringify(body.input)).toContain('msg-1');
  });

  test('drops items citing a message that was not in the input', async () => {
    const hallucinated = {
      overview: 'x',
      topics: [
        {
          emoji: '📣',
          title: 'Invented',
          items: [{ message_id: 'msg-999', headline: 'Nope', note: 'Not real.' }],
        },
        ...DIGEST.topics,
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(hallucinated) }),
    })));

    const result = await buildDigest(MESSAGES, 'key', 'gpt-5.6-luna');
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0].title).toBe('Kitchen Renovation');
  });

  test('throws on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })));
    await expect(buildDigest(MESSAGES, 'key', 'gpt-5.6-luna')).rejects.toThrow(
      'OpenAI request failed (429)',
    );
  });

  test('exposes a prompt version for provenance', () => {
    expect(DIGEST_PROMPT_VERSION).toMatch(/^daily-digest-v/);
  });
});

describe('pruneDigest', () => {
  const known = new Set(['a', 'b', 'c']);
  const topic = (title, ids) => ({
    emoji: '📣',
    title,
    items: ids.map((id) => ({ message_id: id, headline: id, note: id })),
  });

  test('keeps only known message ids and drops emptied topics', () => {
    const result = pruneDigest(
      { overview: 'o', topics: [topic('Real', ['a', 'zz']), topic('Bogus', ['yy'])] },
      known,
    );
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0].items.map((i) => i.message_id)).toEqual(['a']);
  });

  test('lists a message at most once across topics', () => {
    const result = pruneDigest({ overview: 'o', topics: [topic('One', ['a']), topic('Two', ['a', 'b'])] }, known);
    expect(result.topics.map((t) => t.items.map((i) => i.message_id))).toEqual([['a'], ['b']]);
  });

  test('caps the number of topics', () => {
    const topics = Array.from({ length: DIGEST_MAX_TOPICS + 3 }, () => topic('T', ['a']));
    // Each topic claims the same id, so only the first survives deduplication.
    expect(pruneDigest({ overview: 'o', topics }, known).topics).toHaveLength(1);

    const distinct = [topic('A', ['a']), topic('B', ['b']), topic('C', ['c'])];
    expect(pruneDigest({ overview: 'o', topics: distinct }, known).topics).toHaveLength(3);
  });

  test('tolerates a malformed payload', () => {
    expect(pruneDigest({}, known)).toEqual({ overview: '', topics: [] });
    expect(pruneDigest({ overview: 5, topics: 'nope' }, known)).toEqual({ overview: '', topics: [] });
  });
});

describe('fetchDigestMessages', () => {
  test('selects unread inbox mail and excludes archived, sent, deleted and spam', async () => {
    const calls = [];
    const sql = (strings, ...values) => {
      calls.push({ text: strings.join('$'), values });
      return Promise.resolve(MESSAGES);
    };
    const rows = await fetchDigestMessages(/** @type {any} */ (sql), 'user-1');
    expect(rows).toEqual(MESSAGES);

    const { text, values } = calls[0];
    expect(text).toContain('messages.is_unread');
    expect(text).toContain('NOT messages.is_sent');
    expect(text).toContain('NOT messages.is_archived');
    expect(text).toContain('NOT messages.is_deleted');
    expect(text).toContain("spam_verdict, 'inbox') <> 'spam'");
    expect(values).toContain('user-1');
  });
});
