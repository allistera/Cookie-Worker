import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  fetchTopLaunches,
  fetchTopRepos,
  fetchUkHeadlines,
  fetchWestLothianHeadlines,
  parseRssItems,
  previousUkDayWindow,
} from '../src/news-sources.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** @param {any} body @param {{ok?: boolean, status?: number, text?: string}} [options] */
function stubFetch(body, options = {}) {
  const mock = vi.fn(async () => ({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: async () => body,
    text: async () => options.text ?? '',
  }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('previousUkDayWindow', () => {
  // London is one hour ahead in July, so the day boundary is 23:00 UTC.
  test('spans yesterday in UK time during BST', () => {
    const { after, before } = previousUkDayWindow(new Date('2026-07-15T05:00:00Z'));
    expect(after.toISOString()).toBe('2026-07-13T23:00:00.000Z');
    expect(before.toISOString()).toBe('2026-07-14T23:00:00.000Z');
  });

  test('spans yesterday in UK time during GMT', () => {
    const { after, before } = previousUkDayWindow(new Date('2026-01-15T05:00:00Z'));
    expect(after.toISOString()).toBe('2026-01-14T00:00:00.000Z');
    expect(before.toISOString()).toBe('2026-01-15T00:00:00.000Z');
  });

  // At 05:00 UTC in BST it is already 06:00 in London, so "yesterday" is the
  // last complete London day, not the one before it.
  test('uses the UK calendar day, not the UTC one', () => {
    const { before } = previousUkDayWindow(new Date('2026-07-15T23:30:00Z'));
    expect(before.toISOString()).toBe('2026-07-15T23:00:00.000Z');
  });
});

describe('fetchTopRepos', () => {
  const window = {
    after: new Date('2026-07-13T23:00:00Z'),
    before: new Date('2026-07-14T23:00:00Z'),
  };

  test('searches by creation window sorted by stars', async () => {
    const mock = stubFetch({
      items: [
        {
          full_name: 'acme/rocket',
          html_url: 'https://github.com/acme/rocket',
          description: 'Fast things',
          language: 'Rust',
          stargazers_count: 1200,
        },
      ],
    });

    const repos = await fetchTopRepos(window, 'gh-token');

    expect(repos).toEqual([
      {
        title: 'acme/rocket',
        url: 'https://github.com/acme/rocket',
        description: 'Fast things',
        meta: 'Rust · ★ 1200',
      },
    ]);
    const [url, init] = /** @type {[string, any]} */ (/** @type {unknown} */ (mock.mock.calls[0]));
    expect(url).toContain('created%3A2026-07-13T23%3A00%3A00Z..2026-07-14T23%3A00%3A00Z');
    expect(url).toContain('sort=stars');
    expect(init.headers.Authorization).toBe('Bearer gh-token');
  });

  test('works without a token, which only raises the rate limit', async () => {
    const mock = stubFetch({ items: [] });
    await expect(fetchTopRepos(window, undefined)).resolves.toEqual([]);
    const [, noAuth] = /** @type {[string, any]} */ (/** @type {unknown} */ (mock.mock.calls[0]));
    expect(noAuth.headers.Authorization).toBeUndefined();
  });

  test('skips malformed entries', async () => {
    stubFetch({ items: [{ full_name: 'no/url' }, null, { html_url: 'https://x' }] });
    await expect(fetchTopRepos(window, undefined)).resolves.toEqual([]);
  });

  test('throws on a non-OK response', async () => {
    stubFetch(null, { ok: false, status: 403 });
    await expect(fetchTopRepos(window, undefined)).rejects.toThrow('responded 403');
  });
});

describe('fetchTopLaunches', () => {
  const window = {
    after: new Date('2026-07-13T23:00:00Z'),
    before: new Date('2026-07-14T23:00:00Z'),
  };

  test('queries the GraphQL API by votes and maps the nodes', async () => {
    const mock = stubFetch({
      data: {
        posts: {
          edges: [
            {
              node: {
                name: 'Widget',
                tagline: 'Does widgets',
                url: 'https://producthunt.com/posts/widget',
                votesCount: 340,
              },
            },
          ],
        },
      },
    });

    const launches = await fetchTopLaunches(window, 'ph-token');

    expect(launches).toEqual([
      {
        title: 'Widget',
        url: 'https://producthunt.com/posts/widget',
        description: 'Does widgets',
        meta: '▲ 340',
      },
    ]);
    const [, init] = /** @type {[string, any]} */ (/** @type {unknown} */ (mock.mock.calls[0]));
    expect(init.headers.Authorization).toBe('Bearer ph-token');
    const body = JSON.parse(init.body);
    expect(body.query).toContain('order: VOTES');
    expect(body.variables.after).toBe('2026-07-13T23:00:00.000Z');
  });

  // GraphQL reports failures in a 200 body, so a bare ok check is not enough.
  test('throws when the response carries GraphQL errors', async () => {
    stubFetch({ errors: [{ message: 'rate limited' }] });
    await expect(fetchTopLaunches(window, 'ph-token')).rejects.toThrow('rate limited');
  });
});

describe('parseRssItems', () => {
  test('extracts items and unwraps CDATA and entities', () => {
    const xml = `<rss><channel>
      <item>
        <title><![CDATA[Budget & the North]]></title>
        <link>https://bbc.co.uk/news/1</link>
        <description>Chancellor said &quot;more&quot;</description>
        <pubDate>Tue, 14 Jul 2026 21:30:00 GMT</pubDate>
      </item>
      <item><title>No link here</title></item>
    </channel></rss>`;

    const items = parseRssItems(xml);

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Budget & the North');
    expect(items[0].description).toBe('Chancellor said "more"');
    expect(items[0].published).toBe(Date.parse('Tue, 14 Jul 2026 21:30:00 GMT'));
  });

  test('returns nothing for a feed with no items', () => {
    expect(parseRssItems('<rss><channel></channel></rss>')).toEqual([]);
  });
});

describe('fetchUkHeadlines', () => {
  const feed = (pubDate) => `<rss><channel><item>
    <title>Storm warning</title><link>https://bbc.co.uk/news/9</link>
    <description>Wind</description><pubDate>${pubDate}</pubDate>
  </item></channel></rss>`;

  test('keeps only stories from the recent window, newest first', async () => {
    const now = new Date('2026-07-15T12:00:00Z');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => feed('Wed, 15 Jul 2026 09:00:00 GMT'),
      })),
    );

    const headlines = await fetchUkHeadlines(8, 24, now);

    expect(headlines).toHaveLength(1);
    expect(headlines[0].title).toBe('Storm warning');
    expect(headlines[0].url).toBe('https://bbc.co.uk/news/9');
    // Rendered in UK time: 09:00 GMT is 10:00 during BST.
    expect(headlines[0].meta).toBe('BBC News · 10:00');
  });

  test('drops stories older than the window', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => feed('Sun, 12 Jul 2026 09:00:00 GMT'),
      })),
    );

    await expect(fetchUkHeadlines(8, 24, new Date('2026-07-15T12:00:00Z'))).resolves.toEqual([]);
  });
});

describe('fetchWestLothianHeadlines', () => {
  test('reads the Edinburgh Live topic feed with a local source label', async () => {
    const now = new Date('2026-07-15T12:00:00Z');
    const mock = stubFetch(null, {
      text: `<rss><channel><item>
        <title>Bathgate road reopens</title>
        <link>https://www.edinburghlive.co.uk/news/bathgate-road-reopens</link>
        <description>Work is complete</description>
        <pubDate>Mon, 13 Jul 2026 09:00:00 GMT</pubDate>
      </item></channel></rss>`,
    });

    const headlines = await fetchWestLothianHeadlines(3, 72, now);

    expect(headlines).toEqual([
      {
        title: 'Bathgate road reopens',
        url: 'https://www.edinburghlive.co.uk/news/bathgate-road-reopens',
        description: 'Work is complete',
        meta: 'Edinburgh Live · 10:00',
      },
    ]);
    const [requestedUrl] = /** @type {[string, any]} */ (
      /** @type {unknown} */ (mock.mock.calls[0])
    );
    expect(requestedUrl).toBe('https://www.edinburghlive.co.uk/all-about/west-lothian?service=rss');
  });
});
