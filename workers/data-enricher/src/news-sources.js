import { fetchWithTimeout } from '../../../shared/fetch.js';

// Source fetchers for AI Today's daily news section, ported from the
// allistera/daily-news Python project. Each returns plain
// {title, url, description, meta} items; ranking happens in news.js.

export const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
export const PRODUCT_HUNT_URL = 'https://api.producthunt.com/v2/api/graphql';
export const BBC_UK_FEED_URL = 'https://feeds.bbci.co.uk/news/uk/rss.xml';
export const USER_AGENT = 'cookie-data-enricher';

/**
 * Minutes Europe/London is ahead of UTC at `date` (60 under BST, 0 under GMT).
 *
 * @param {Date} date
 */
function ukOffsetMinutes(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/London',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

/** The instant a Europe/London calendar day (YYYY-MM-DD) begins, as a Date. */
function ukMidnight(isoDate) {
  const guess = Date.parse(`${isoDate}T00:00:00Z`);
  // UK DST switches at 01:00 local, so local midnight is never ambiguous.
  return new Date(guess - ukOffsetMinutes(new Date(guess)) * 60_000);
}

/**
 * Yesterday's Europe/London calendar day as { after, before } UTC bounds — the
 * window every source covers, matching daily-news. The cron runs at 05:00 UTC,
 * so "yesterday" is the last complete day.
 *
 * @param {Date} [now]
 */
export function previousUkDayWindow(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { after: ukMidnight(yesterday), before: ukMidnight(today) };
}

/** @param {string} url @param {RequestInit} [init] */
async function fetchJson(url, init = {}) {
  return fetchWithTimeout(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) },
  }, async (response) => {
    if (!response.ok) throw new Error(`${new URL(url).host} responded ${response.status}`);
    return response.json();
  });
}

/**
 * The most-starred repositories created during the window. The token is
 * optional — it only raises the rate limit.
 *
 * @param {{after: Date, before: Date}} window
 * @param {string | undefined} token
 * @param {number} [count]
 */
export async function fetchTopRepos(window, token, count = 20) {
  const query = new URLSearchParams({
    q: `created:${window.after.toISOString().slice(0, 19)}Z..${window.before.toISOString().slice(0, 19)}Z`,
    sort: 'stars',
    order: 'desc',
    per_page: String(count),
  });
  const body = await fetchJson(`${GITHUB_SEARCH_URL}?${query}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  return (Array.isArray(body?.items) ? body.items : [])
    .filter((repo) => repo?.full_name && repo?.html_url)
    .map((repo) => ({
      title: repo.full_name,
      url: repo.html_url,
      description: repo.description || '',
      meta: [repo.language, `★ ${repo.stargazers_count ?? 0}`].filter(Boolean).join(' · '),
    }));
}

const PRODUCT_HUNT_QUERY = `
  query DailyPosts($after: DateTime!, $before: DateTime!, $first: Int!) {
    posts(order: VOTES, postedAfter: $after, postedBefore: $before, first: $first) {
      edges { node { name tagline url votesCount } }
    }
  }
`;

/**
 * The day's top Product Hunt launches by votes.
 *
 * daily-news reaches Product Hunt through a stdio MCP server, which a Worker
 * cannot spawn, so this talks to the GraphQL API directly with the same token.
 *
 * @param {{after: Date, before: Date}} window
 * @param {string} token
 * @param {number} [count]
 */
export async function fetchTopLaunches(window, token, count = 20) {
  const body = await fetchJson(PRODUCT_HUNT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: PRODUCT_HUNT_QUERY,
      variables: {
        after: window.after.toISOString(),
        before: window.before.toISOString(),
        first: count,
      },
    }),
  });
  if (body?.errors?.length) {
    throw new Error(`Product Hunt query failed: ${body.errors[0]?.message ?? 'unknown error'}`);
  }
  return (body?.data?.posts?.edges || [])
    .map((edge) => edge?.node)
    .filter((post) => post?.name && post?.url)
    .map((post) => ({
      title: post.name,
      url: post.url,
      description: post.tagline || '',
      meta: `▲ ${post.votesCount ?? 0}`,
    }));
}

/** Decode the handful of XML entities an RSS feed can carry. */
function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(item, tag) {
  const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? decodeXml(match[1]) : '';
}

/**
 * Parse an RSS 2.0 feed. Workers have no XML parser and RSS is regular enough
 * not to warrant a dependency for one well-known feed.
 *
 * @param {string} xml
 */
export function parseRssItems(xml) {
  return [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/g)]
    .map(([, item]) => {
      const published = Date.parse(tagText(item, 'pubDate'));
      return {
        title: tagText(item, 'title'),
        url: tagText(item, 'link'),
        description: tagText(item, 'description'),
        published: Number.isFinite(published) ? published : null,
      };
    })
    .filter((item) => item.title && item.url);
}

/**
 * UK headlines from the last `hours`, most recent first. Deliberately not
 * personalised: filtering "what happened" through "what you like" is how you
 * miss the thing you needed to know.
 *
 * @param {number} [count]
 * @param {number} [hours]
 * @param {Date} [now]
 */
export async function fetchUkHeadlines(count = 8, hours = 24, now = new Date()) {
  const xml = await fetchWithTimeout(BBC_UK_FEED_URL, {
    headers: { 'User-Agent': USER_AGENT },
  }, async (response) => {
    if (!response.ok) throw new Error(`BBC responded ${response.status}`);
    return response.text();
  });

  const since = now.getTime() - hours * 3_600_000;
  // Built with a loop rather than filter().sort() so `published` is known to be
  // a number from here on; an item without a parseable pubDate can't be placed
  // in the window at all.
  /** @type {Array<{title: string, url: string, description: string, published: number}>} */
  const recent = [];
  for (const item of parseRssItems(xml)) {
    if (item.published === null || item.published < since) continue;
    recent.push({ ...item, published: item.published });
  }

  return recent
    .sort((a, b) => b.published - a.published)
    .slice(0, count)
    .map((item) => ({
      title: item.title,
      url: item.url,
      description: item.description,
      meta: new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(item.published)),
    }));
}
