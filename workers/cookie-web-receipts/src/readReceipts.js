// Ported from Cookie-Web's api/read-receipts.js. Behaviorally identical
// (same queries, same validation, same response shapes/status codes) — only
// the (req, res) mutation style becomes returning a Response, and the pixel
// bytes come from atob instead of node:buffer.

import { validId } from '../../../shared/pagination.js';

const MAX_MESSAGES = 100;
// A transparent 1x1 GIF. Receipt requests always return the same image so an
// invalid or expired opaque token reveals nothing about mailbox state.
const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='), (c) => c.charCodeAt(0));
// Flood guard for the unauthenticated pixel path — the only route that touches
// Postgres without a token. In-memory state is per isolate (the Workers
// analogue of Vercel's per-serverless-instance state this ports), so it bounds
// how much database load a single isolate will generate rather than enforcing
// a global quota; a platform-level WAF rule is the global control.
const PIXEL_WINDOW_MS = 60_000;
const PIXEL_MAX_PER_WINDOW = 120;
const PIXEL_HITS_PRUNE_SIZE = 10_000;
const pixelHits = new Map();

/** @param {Request} request */
export function clientIp(request) {
  // CF-Connecting-IP is set by Cloudflare itself and cannot be spoofed by the
  // caller, unlike the X-Forwarded-For chain the Vercel handler had to parse.
  return (
    request.headers.get('CF-Connecting-IP') ??
    (request.headers.get('X-Forwarded-For') ?? '').split(',')[0].trim() ??
    'unknown'
  );
}

/** @param {string} ip @param {number} [now] */
export function pixelFlooded(ip, now = Date.now()) {
  const entry = pixelHits.get(ip);
  if (!entry || now - entry.windowStart >= PIXEL_WINDOW_MS) {
    // Hard cap with O(1) eviction: a flood of fresh spoofed addresses must
    // not grow the map past the cap or trigger full-map scans per request.
    // Entries are kept in window-start order (delete+set moves a recycled
    // window to the back), so the first key is always the oldest window and
    // the most likely to be expired.
    if (!entry && pixelHits.size >= PIXEL_HITS_PRUNE_SIZE) {
      const oldest = pixelHits.keys().next().value;
      if (oldest !== undefined) pixelHits.delete(oldest);
    }
    pixelHits.delete(ip);
    pixelHits.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > PIXEL_MAX_PER_WINDOW;
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} token
 */
export function recordReadReceipt(sql, token) {
  return sql`
    UPDATE message_read_receipts
    SET first_opened_at = COALESCE(first_opened_at, now()),
        last_opened_at = now(),
        open_count = open_count + 1
    WHERE token = ${token}
      AND expires_at > now()
      AND (
        last_opened_at IS NULL OR
        last_opened_at < now() - interval '5 minutes'
      )
  `;
}

/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string[]} messageIds
 */
export function fetchOwnedReadReceipts(sql, userId, messageIds) {
  return sql`
    SELECT r.message_id, r.first_opened_at, r.last_opened_at, r.open_count
    FROM message_read_receipts r
    WHERE r.user_id = ${userId}
      AND r.message_id = ANY(${messageIds}::uuid[])
  `;
}

function pixelResponse() {
  return new Response(PIXEL, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(PIXEL.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
    },
  });
}

/**
 * The unauthenticated tracking pixel. The response is identical for a valid,
 * invalid, expired, or flood-limited token, so nothing about mailbox state
 * leaks to recipients — and tracking failures never affect the image either.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} token
 * @param {string} ip
 */
export async function handlePixel(sql, token, ip) {
  if (validId(token) && !pixelFlooded(ip)) {
    try {
      await recordReadReceipt(sql, token);
    } catch (err) {
      // Tracking must never affect delivery or leak failures to recipients.
      // 42P01 (missing table during a rolling deploy) is expected noise.
      if (/** @type {{code?: string}} */ (err)?.code !== '42P01') {
        console.error('GET /read-receipts (pixel) failed:', err);
      }
    }
  }
  return pixelResponse();
}

/**
 * The authenticated status route: receipt state for up to 100 sent messages
 * the caller owns.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {URL} url
 */
export async function handleStatus(sql, userId, url) {
  // Bound the parameter before split() expands it: 100 UUIDs plus commas is
  // 3,699 chars, so anything past 4,000 can't be a valid request.
  const rawParam = url.searchParams.get('messageIds') || '';
  const rawIds = rawParam.length > 4000 ? [] : rawParam.split(',').filter(Boolean);
  if (rawIds.length === 0 || rawIds.length > MAX_MESSAGES || !rawIds.every((id) => validId(id))) {
    return Response.json({ error: 'One to 100 valid messageIds are required' }, { status: 400 });
  }

  try {
    const receipts = await fetchOwnedReadReceipts(sql, userId, rawIds);
    return Response.json({ receipts });
  } catch (err) {
    // During a rolling deploy the new table may not exist yet. Sent mail stays
    // usable and simply shows the conservative, unopened state until it does.
    if (/** @type {{code?: string}} */ (err)?.code !== '42P01') {
      console.error('GET /read-receipts (status) failed:', err);
    }
    return Response.json({ receipts: [] });
  }
}
