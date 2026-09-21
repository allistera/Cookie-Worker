// Cookie-Web's "Send Later" feature (scheduled_sends table + scheduled_for
// column) needs something to actually call the mail provider once a
// scheduled row is due — unlike inbound snooze, whose due rows just become
// visible again the next time they're queried. This Worker is that clock:
// on a cron tick it calls cookie-web-send's POST /send/flush over the SEND
// service binding; that Worker owns every bit of the real logic (claiming
// due rows, Resend, storing the sent copy, retry/failure bookkeeping). This
// Worker never touches Postgres or Resend directly. (The Sentry-grouped
// "Cookie-Web flush responded <status>" message prefix predates the flush
// endpoint's own move off Vercel and is kept for issue continuity.)

import * as Sentry from '@sentry/cloudflare';
import { timingSafeEqualStrings } from '../../../shared/auth.js';
import { fetchWithTimeout } from '../../../shared/fetch.js';
import { retryWithBackoff } from '../../../shared/retry.js';
import { captureHandledException, createSentryOptions, redact, tagTrigger } from './sentry.js';

const FLUSH_TIMEOUT_MS = 20_000;
// The Sep 9 database outage lasted ten seconds or more and outlasted three
// attempts a second apart (Sentry COOKIE-WEB-14). The cron ticks every five
// minutes and the flush is idempotent, so waiting longer costs nothing.
export const FLUSH_RETRY_BASE_DELAY_MS = 5000;
const MAX_FLUSH_ERROR_BODY_LENGTH = 200;

class FlushHttpError extends Error {
  /** @param {number} status @param {string} [detail] */
  constructor(status, detail) {
    // The `Cookie-Web flush responded <status>` prefix is load-bearing: it is
    // what Sentry groups on, and what the retry classifier's tests assert.
    // The detail distinguishes Cookie-Web's own error responses (e.g. "Email
    // sending is not configured") from bare platform-level 5xxs, which a
    // status code alone cannot.
    super(`Cookie-Web flush responded ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'FlushHttpError';
    this.status = status;
  }
}

/** @param {unknown} error */
function isRetryableFlushError(error) {
  return (
    (error instanceof FlushHttpError && error.status >= 500) ||
    error instanceof TypeError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

// The hostname is only an addressing formality the service binding requires.
const FLUSH_URL = 'https://cookie-web-send/send/flush';

/**
 * @param {Env & {COOKIE_WEB_FLUSH_TOKEN?: string}} env
 */
async function fetchFlush(env) {
  return fetchWithTimeout(
    FLUSH_URL,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.COOKIE_WEB_FLUSH_TOKEN}` },
    },
    async (response) => {
      if (!response.ok) {
        let detail = '';
        if (typeof response.text === 'function') {
          try {
            // Best-effort, still inside the fetchWithTimeout deadline. The
            // body goes through this Worker's env-aware redact before it can
            // reach Sentry — Cookie-Web echoes request details in some error
            // responses, and the flush token must never leave the isolate.
            detail = redact((await response.text()).slice(0, MAX_FLUSH_ERROR_BODY_LENGTH), env);
          } catch {
            // Keep the upstream status when its error body cannot be read.
          }
        }
        throw new FlushHttpError(response.status, detail.trim() || undefined);
      }
      return response.json();
    },
    FLUSH_TIMEOUT_MS,
    (input, init) => env.SEND.fetch(input, init),
  );
}

/**
 * @param {Env & {COOKIE_WEB_FLUSH_TOKEN?: string}} env
 */
export async function flushScheduledSends(env) {
  if (!env.SEND) throw new Error('The SEND service binding is not configured');
  if (!env.COOKIE_WEB_FLUSH_TOKEN) throw new Error('COOKIE_WEB_FLUSH_TOKEN is not configured');

  const result = await retryWithBackoff(() => fetchFlush(env), {
    attempts: 3,
    baseDelayMs: FLUSH_RETRY_BASE_DELAY_MS,
    isRetryable: isRetryableFlushError,
  });
  console.log(JSON.stringify({ event: 'scheduled_sends_flushed', ...result }));
  return result;
}

const worker = {
  /**
   * @param {ScheduledController} _controller
   * @param {Env & {COOKIE_WEB_FLUSH_TOKEN?: string}} env
   * @param {ExecutionContext} _ctx
   */
  async scheduled(_controller, env, _ctx) {
    tagTrigger('scheduled');
    await flushScheduledSends(env);
  },

  /**
   * Manual trigger: POST /run with `Authorization: Bearer <HTTP_TRIGGER_TOKEN>`.
   * @param {Request} request
   * @param {Env & {COOKIE_WEB_FLUSH_TOKEN?: string, HTTP_TRIGGER_TOKEN?: string}} env
   * @param {ExecutionContext} _ctx
   */
  async fetch(request, env, _ctx) {
    tagTrigger('http');
    const url = new URL(request.url);
    if (url.pathname !== '/run') {
      return new Response('Not Found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    }
    // An unset token keeps the endpoint closed rather than open.
    if (
      !env.HTTP_TRIGGER_TOKEN ||
      !(await timingSafeEqualStrings(
        request.headers.get('Authorization'),
        `Bearer ${env.HTTP_TRIGGER_TOKEN}`,
      ))
    ) {
      return new Response('Unauthorized', { status: 401 });
    }
    try {
      const result = await flushScheduledSends(env);
      return Response.json({ status: 'ok', ...result });
    } catch (error) {
      // Body stays generic: nested errors may carry connection details.
      console.log(JSON.stringify({ event: 'http_run_failed', error: redact(error, env) }));
      // The cron path lets failures escape, so `withSentry` reports them; this
      // one is answered with a 500 and would otherwise be invisible.
      captureHandledException('http_run', error, env);
      return Response.json({ status: 'failed' }, { status: 500 });
    }
  },
};

export default Sentry.withSentry(createSentryOptions, worker);
