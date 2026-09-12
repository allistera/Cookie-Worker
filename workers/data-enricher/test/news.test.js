import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/news-sources.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchTopRepos: vi.fn(),
  fetchTopLaunches: vi.fn(),
  fetchUkHeadlines: vi.fn(),
  fetchWestLothianHeadlines: vi.fn(),
}));

import {
  applyRanking,
  buildNews,
  rankForInterests,
  GITHUB_PICKS,
  HEADLINE_PICKS,
  MAX_PICKS_PER_SOURCE,
  NEWS_MAX_OUTPUT_TOKENS,
  NEWS_TIMEOUT_MS,
} from '../src/news.js';
import {
  fetchTopLaunches,
  fetchTopRepos,
  fetchUkHeadlines,
  fetchWestLothianHeadlines,
} from '../src/news-sources.js';

beforeEach(() => {
  vi.mocked(fetchWestLothianHeadlines).mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const CANDIDATES = [
  {
    title: 'acme/rocket',
    url: 'https://github.com/acme/rocket',
    description: 'Fast',
    meta: '★ 10',
  },
  { title: 'acme/slow', url: 'https://github.com/acme/slow', description: 'Slow', meta: '★ 2' },
];

function stubRanking(picks) {
  const mock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ output_text: JSON.stringify({ picks }) }),
  }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('applyRanking', () => {
  test('keeps the model order and attaches its note', () => {
    const picked = applyRanking(
      {
        picks: [
          { url: CANDIDATES[1].url, note: 'Matches Rust' },
          { url: CANDIDATES[0].url, note: 'Fast' },
        ],
      },
      CANDIDATES,
    );
    expect(picked.map((p) => p.title)).toEqual(['acme/slow', 'acme/rocket']);
    expect(picked[0].note).toBe('Matches Rust');
    expect(picked[0].meta).toBe('★ 2');
  });

  // These links leave the app, so an invented URL must never be rendered.
  test('drops urls that were not among the candidates', () => {
    const picked = applyRanking(
      {
        picks: [
          { url: 'https://evil.example/malware', note: 'Trust me' },
          { url: CANDIDATES[0].url, note: 'ok' },
        ],
      },
      CANDIDATES,
    );
    expect(picked.map((p) => p.url)).toEqual([CANDIDATES[0].url]);
  });

  test('lists a candidate at most once', () => {
    const picked = applyRanking(
      {
        picks: [
          { url: CANDIDATES[0].url, note: 'a' },
          { url: CANDIDATES[0].url, note: 'b' },
        ],
      },
      CANDIDATES,
    );
    expect(picked).toHaveLength(1);
  });

  test('caps the number of picks', () => {
    const many = Array.from({ length: MAX_PICKS_PER_SOURCE + 4 }, (_, i) => ({
      title: `repo-${i}`,
      url: `https://github.com/acme/repo-${i}`,
      description: '',
      meta: '',
    }));
    const picks = many.map((c) => ({ url: c.url, note: 'n' }));
    expect(applyRanking({ picks }, many)).toHaveLength(MAX_PICKS_PER_SOURCE);
  });

  test('tolerates a malformed payload', () => {
    expect(applyRanking({}, CANDIDATES)).toEqual([]);
    expect(applyRanking({ picks: 'nope' }, CANDIDATES)).toEqual([]);
  });
});

describe('per-source pick limits', () => {
  const many = (count) =>
    Array.from({ length: count }, (_, i) => ({
      title: `acme/${i}`,
      url: `https://github.com/acme/${i}`,
      description: '',
      meta: '',
    }));

  test('caps at the limit the source asks for', () => {
    const candidates = many(GITHUB_PICKS + 4);
    const picks = candidates.map((c) => ({ url: c.url, note: '' }));

    expect(applyRanking({ picks }, candidates, GITHUB_PICKS)).toHaveLength(GITHUB_PICKS);
    // A source that asks for nothing in particular keeps the shared default.
    expect(applyRanking({ picks }, candidates)).toHaveLength(MAX_PICKS_PER_SOURCE);
  });

  test('asks the model for the requested limit and caps the unranked path too', async () => {
    const candidates = many(GITHUB_PICKS + 4);
    const mock = stubRanking(candidates.map((c) => ({ url: c.url, note: '' })));

    const picked = await rankForInterests(
      candidates,
      ['Rust'],
      'repos',
      'key',
      'gpt-5.6-luna',
      GITHUB_PICKS,
    );
    expect(picked).toHaveLength(GITHUB_PICKS);
    const [, init] = /** @type {[string, any]} */ (/** @type {unknown} */ (mock.mock.calls[0]));
    expect(JSON.parse(init.body).input[0].content).toContain(`at most ${GITHUB_PICKS}`);

    vi.stubGlobal('fetch', vi.fn());
    const unranked = await rankForInterests(candidates, [], 'repos', 'key', 'm', GITHUB_PICKS);
    expect(unranked).toHaveLength(GITHUB_PICKS);
  });
});

describe('rankForInterests', () => {
  test('sends the interests and candidates and returns the picks', async () => {
    const mock = stubRanking([{ url: CANDIDATES[0].url, note: 'Rust, like you asked for' }]);

    const picked = await rankForInterests(CANDIDATES, ['Rust'], 'repos', 'key', 'gpt-5.6-luna');

    expect(picked).toHaveLength(1);
    expect(picked[0].note).toBe('Rust, like you asked for');
    const [, init] = /** @type {[string, any]} */ (/** @type {unknown} */ (mock.mock.calls[0]));
    const body = JSON.parse(init.body);
    expect(JSON.stringify(body.input)).toContain('Rust');
    expect(body.text.format.type).toBe('json_schema');
    expect(body.max_output_tokens).toBe(NEWS_MAX_OUTPUT_TOKENS);
    expect(body.max_output_tokens).toBe(8000);
  });

  // Nothing to rank against, so spending a model call would be pointless.
  test('takes the top items unranked when no interests are stored', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);

    const picked = await rankForInterests(CANDIDATES, [], 'repos', 'key', 'gpt-5.6-luna');

    expect(picked.map((p) => p.title)).toEqual(['acme/rocket', 'acme/slow']);
    expect(mock).not.toHaveBeenCalled();
  });

  test('makes no call when there is nothing to rank', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    await expect(rankForInterests([], ['Rust'], 'repos', 'key', 'm')).resolves.toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('buildNews', () => {
  const options = {
    personaliseGithub: true,
    interests: [],
    apiKey: 'key',
    model: 'gpt-5.6-luna',
    githubToken: 'gh',
    productHuntToken: 'ph',
  };

  test('keeps every GitHub candidate without ranking by default, even with interests', async () => {
    const candidates = Array.from({ length: 15 }, (_, i) => ({
      ...CANDIDATES[0],
      url: `https://github.com/acme/${i}`,
    }));
    vi.mocked(fetchTopRepos).mockResolvedValue(candidates);
    vi.mocked(fetchUkHeadlines).mockResolvedValue([]);
    const { sections } = await buildNews({ interests: ['Rust'], apiKey: 'key', model: 'model' });
    expect(sections.find((section) => section.title === 'GitHub').items).toEqual(
      candidates.map((item) => ({ ...item, note: '' })),
    );
  });

  test.each(['incomplete', 'http', 'timeout'])(
    'keeps capped source items when ranking fails: %s',
    async (failure) => {
      vi.useFakeTimers();
      const candidates = Array.from({ length: 15 }, (_, index) => ({
        ...CANDIDATES[0],
        url: `https://github.com/acme/${index}`,
      }));
      vi.mocked(fetchTopRepos).mockResolvedValue(candidates);
      vi.mocked(fetchTopLaunches).mockResolvedValue(candidates);
      vi.mocked(fetchUkHeadlines).mockResolvedValue([]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          if (failure === 'timeout') {
            return new Promise((_resolve, reject) => {
              init.signal.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
              );
            });
          }
          return {
            ok: failure !== 'http',
            status: 503,
            json: async () => ({
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
            }),
          };
        }),
      );
      const pending = buildNews({ ...options, interests: ['Rust'] });
      await vi.advanceTimersByTimeAsync(NEWS_TIMEOUT_MS);
      const { sections } = await pending;
      expect(sections.map((s) => s.title)).toEqual(['GitHub', 'Product Hunt']);
      expect(sections[0].items).toHaveLength(GITHUB_PICKS);
      expect(sections[1].items).toHaveLength(MAX_PICKS_PER_SOURCE);
      for (const section of sections) {
        expect(section.items.map((item) => item.url)).toEqual(
          candidates.slice(0, section.items.length).map((item) => item.url),
        );
        expect(
          section.items.every(
            (item) => item.note === 'Popular item — personalisation unavailable.',
          ),
        ).toBe(true);
      }
    },
  );

  test('does not replace a successful ranking with no matches by popular items', async () => {
    stubRanking([]);
    vi.mocked(fetchTopRepos).mockResolvedValue(CANDIDATES);
    vi.mocked(fetchTopLaunches).mockResolvedValue(CANDIDATES);
    vi.mocked(fetchUkHeadlines).mockResolvedValue([]);
    expect((await buildNews({ ...options, interests: ['Rust'] })).sections).toEqual([]);
  });

  test('builds a section per source', async () => {
    vi.mocked(fetchTopRepos).mockResolvedValue([CANDIDATES[0]]);
    vi.mocked(fetchTopLaunches).mockResolvedValue([
      { title: 'Widget', url: 'https://ph/w', description: 'w', meta: '▲ 3' },
    ]);
    vi.mocked(fetchUkHeadlines).mockResolvedValue([
      { title: 'Storm', url: 'https://bbc/1', description: 's', meta: 'BBC News · 10:00' },
    ]);

    const { sections } = await buildNews(options);

    expect(sections.map((s) => s.title)).toEqual(['GitHub', 'Product Hunt', 'UK headlines']);
    expect(sections[2].items[0].title).toBe('Storm');
  });

  test('reserves three local places and fills a ten-story headline list from BBC', async () => {
    vi.mocked(fetchTopRepos).mockResolvedValue([]);
    vi.mocked(fetchTopLaunches).mockResolvedValue([]);
    vi.mocked(fetchWestLothianHeadlines).mockResolvedValue(
      Array.from({ length: 3 }, (_, index) => ({
        title: `Local ${index}`,
        url: `https://edinburghlive/${index}`,
        description: 'local',
        meta: 'Edinburgh Live · 10:00',
      })),
    );
    vi.mocked(fetchUkHeadlines).mockResolvedValue(
      Array.from({ length: HEADLINE_PICKS }, (_, index) => ({
        title: `UK ${index}`,
        url: `https://bbc/${index}`,
        description: 'national',
        meta: 'BBC News · 11:00',
      })),
    );

    const { sections } = await buildNews(options);
    const headlines = sections.find((section) => section.title === 'UK headlines');

    expect(headlines.items).toHaveLength(HEADLINE_PICKS);
    expect(headlines.items.slice(0, 3).map((item) => item.title)).toEqual([
      'Local 0',
      'Local 1',
      'Local 2',
    ]);
    expect(headlines.items.at(-1).title).toBe('UK 6');
  });

  // One source being down or unconfigured must not cost the others.
  test('drops a failed source and keeps the rest', async () => {
    vi.mocked(fetchTopRepos).mockRejectedValue(new Error('github down'));
    vi.mocked(fetchTopLaunches).mockResolvedValue([
      { title: 'Widget', url: 'https://ph/w', description: 'w', meta: '▲ 3' },
    ]);
    vi.mocked(fetchUkHeadlines).mockResolvedValue([]);

    const { sections } = await buildNews(options);

    expect(sections.map((s) => s.title)).toEqual(['Product Hunt']);
  });

  test('skips Product Hunt when no token is configured', async () => {
    vi.mocked(fetchTopRepos).mockResolvedValue([CANDIDATES[0]]);
    vi.mocked(fetchUkHeadlines).mockResolvedValue([]);

    const { sections } = await buildNews({ ...options, productHuntToken: undefined });

    expect(sections.map((s) => s.title)).toEqual(['GitHub']);
    expect(fetchTopLaunches).not.toHaveBeenCalled();
  });

  // Headlines are "what happened", not "what you like".
  test('never personalises UK headlines', async () => {
    const ranked = stubRanking([{ url: CANDIDATES[0].url, note: 'yours' }]);
    vi.mocked(fetchTopRepos).mockResolvedValue(CANDIDATES);
    vi.mocked(fetchTopLaunches).mockResolvedValue([]);
    vi.mocked(fetchUkHeadlines).mockResolvedValue([
      { title: 'Storm', url: 'https://bbc/1', description: 's', meta: 'BBC News · 10:00' },
      { title: 'Budget', url: 'https://bbc/2', description: 'b', meta: 'BBC News · 11:00' },
    ]);

    const { sections } = await buildNews({ ...options, interests: ['Rust'] });

    const headlines = sections.find((s) => s.title === 'UK headlines');
    expect(headlines.items.map((i) => i.title)).toEqual(['Storm', 'Budget']);
    // Only GitHub went to the model; Product Hunt was empty, BBC never goes.
    expect(ranked).toHaveBeenCalledTimes(1);
  });
});
