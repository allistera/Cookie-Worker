// Ported from Cookie-Web's api/_lib/enricher.js — the run URL and trigger
// token are passed in explicitly (env bindings) rather than read from
// process.env, and (req, res) handling becomes returning a Response.

import { allowRequest } from './rateLimit.js';

// A triage rebuild is one model call in the Worker, so it is cheap enough to
// offer on demand but not free: cap it well below what a held-down button
// could manage.
export const RATE_LIMIT = { limit: 4, windowMs: 60_000 };

// The Worker's own trigger takes a while (a database round trip plus the model
// call), but not longer than a user will wait behind a spinner.
const TIMEOUT_MS = 30_000;

export class EnricherNotConfiguredError extends Error {
  constructor() {
    super('The enricher trigger is not configured');
    this.name = 'EnricherNotConfiguredError';
  }
}

// Ask the data-enricher Worker to rebuild both AI Today cards — mail triage
// and the news round-up — and nothing else. The URL and token come from this
// Worker's own environment, never from the request, so this is not an SSRF
// surface and needs no safe-https treatment; the token stays server-side so
// the browser never holds a Worker credential.
/** @param {string | undefined} runUrl @param {string | undefined} token */
export async function triggerDigestRebuild(runUrl, token) {
  if (!runUrl || !token) throw new EnricherNotConfiguredError();

  const url = new URL(runUrl);
  url.searchParams.set('phase', 'today');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Enricher responded ${response.status}`);
  }
}

// POST /tasks/refresh — rebuild AI Today's triage now instead of waiting for
// the Worker's nightly cron. Returns 200 once it has been written, so the
// caller can re-read /tasks and see the new priority groups.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {string | undefined} runUrl
 * @param {string | undefined} triggerToken
 */
export async function postRefresh(sql, userId, runUrl, triggerToken) {
  let allowed;
  try {
    allowed = await allowRequest(sql, userId, 'enricher', RATE_LIMIT);
  } catch (err) {
    console.log(
      JSON.stringify({
        event: 'refresh_quota_failed',
        message: /** @type {Error} */ (err).message,
      }),
    );
    return Response.json({ error: 'Refresh is temporarily unavailable' }, { status: 503 });
  }
  if (!allowed) {
    return Response.json({ error: 'Too many refreshes. Try again shortly.' }, { status: 429 });
  }

  try {
    await triggerDigestRebuild(runUrl, triggerToken);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof EnricherNotConfiguredError) {
      // A deployment without the Worker wired up should say so plainly rather
      // than look like a transient failure the user could retry away.
      return Response.json(
        { error: 'Refresh is not configured for this deployment' },
        { status: 501 },
      );
    }
    console.log(
      JSON.stringify({ event: 'refresh_failed', message: /** @type {Error} */ (err).message }),
    );
    return Response.json({ error: 'Failed to refresh' }, { status: 502 });
  }
}
