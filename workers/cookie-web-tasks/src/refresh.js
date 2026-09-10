// Ported from Cookie-Web's api/_lib/enricher.js — the enricher is reached
// over a service binding (env.ENRICHER) rather than its public URL, the
// trigger token is passed in explicitly (env binding) rather than read from
// process.env, and (req, res) handling becomes returning a Response.

import { allowRequest } from './rateLimit.js';

// A triage rebuild is one model call in the Worker, so it is cheap enough to
// offer on demand but not free: cap it well below what a held-down button
// could manage.
export const RATE_LIMIT = { limit: 4, windowMs: 60_000 };

// The data-enricher may make two bounded 60-second triage attempts before its
// news request, so keep the service-binding deadline outside that retry budget.
export const TIMEOUT_MS = 180_000;

export class EnricherNotConfiguredError extends Error {
  constructor() {
    super('The enricher trigger is not configured');
    this.name = 'EnricherNotConfiguredError';
  }
}

// Ask the data-enricher Worker to rebuild both AI Today cards — mail triage
// and the news round-up — and nothing else. The call goes over a service
// binding, so it never touches the public internet; the hostname below is
// only an addressing formality the binding requires. The token still rides
// along because /run also answers on data-enricher's public workers.dev URL
// and must stay protected there; it comes from this Worker's own
// environment, never from the request, so the browser never holds it.
/** @param {Fetcher | undefined} enricher @param {string | undefined} token */
export async function triggerDigestRebuild(enricher, token) {
  if (!enricher || !token) throw new EnricherNotConfiguredError();

  const url = new URL('https://data-enricher/run');
  url.searchParams.set('phase', 'today');
  const response = await enricher.fetch(url.toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Enricher responded ${response.status}`);
  }
}

// POST /tasks/refresh — rebuild AI Today's triage now instead of waiting for
// the Worker's next configured slot. Returns 200 once it has been written, so the
// caller can re-read /tasks and see the new priority groups.
/**
 * @param {import('postgres').Sql} sql
 * @param {string} userId
 * @param {Fetcher | undefined} enricher
 * @param {string | undefined} triggerToken
 */
export async function postRefresh(sql, userId, enricher, triggerToken) {
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
    await triggerDigestRebuild(enricher, triggerToken);
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
