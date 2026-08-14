// Cookie-Web's "Send Later" feature (scheduled_sends table + scheduled_for
// column) needs something to actually call the mail provider once a
// scheduled row is due — unlike inbound snooze, whose due rows just become
// visible again the next time they're queried. This Worker is that clock:
// on a cron tick it calls Cookie-Web's POST /api/send?resource=flush, which
// owns every bit of the real logic (claiming due rows, Resend, storing the
// sent copy, retry/failure bookkeeping). This Worker never touches Postgres
// or Resend directly.

import { timingSafeEqualStrings } from '../../../shared/auth.js';
import { fetchWithTimeout } from '../../../shared/fetch.js';

const FLUSH_TIMEOUT_MS = 20_000;

/**
 * @param {Env & {COOKIE_WEB_FLUSH_URL?: string, COOKIE_WEB_FLUSH_TOKEN?: string}} env
 */
export async function flushScheduledSends(env) {
  if (!env.COOKIE_WEB_FLUSH_URL) throw new Error('COOKIE_WEB_FLUSH_URL is not configured');
  if (!env.COOKIE_WEB_FLUSH_TOKEN) throw new Error('COOKIE_WEB_FLUSH_TOKEN is not configured');

  const result = await fetchWithTimeout(env.COOKIE_WEB_FLUSH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.COOKIE_WEB_FLUSH_TOKEN}` },
  }, async (response) => {
    if (!response.ok) {
      throw new Error(`Cookie-Web flush responded ${response.status}`);
    }
    return response.json();
  }, FLUSH_TIMEOUT_MS);
  console.log(JSON.stringify({ event: 'scheduled_sends_flushed', ...result }));
  return result;
}

export default {
  /**
   * @param {ScheduledController} _controller
   * @param {Env & {COOKIE_WEB_FLUSH_URL?: string, COOKIE_WEB_FLUSH_TOKEN?: string}} env
   * @param {ExecutionContext} _ctx
   */
  async scheduled(_controller, env, _ctx) {
    await flushScheduledSends(env);
  },

  /**
   * Manual trigger: POST /run with `Authorization: Bearer <HTTP_TRIGGER_TOKEN>`.
   * @param {Request} request
   * @param {Env & {COOKIE_WEB_FLUSH_URL?: string, COOKIE_WEB_FLUSH_TOKEN?: string, HTTP_TRIGGER_TOKEN?: string}} env
   * @param {ExecutionContext} _ctx
   */
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/run') {
      return new Response('Not Found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    }
    // An unset token keeps the endpoint closed rather than open.
    if (!env.HTTP_TRIGGER_TOKEN
      || !(await timingSafeEqualStrings(request.headers.get('Authorization'), `Bearer ${env.HTTP_TRIGGER_TOKEN}`))) {
      return new Response('Unauthorized', { status: 401 });
    }
    try {
      const result = await flushScheduledSends(env);
      return Response.json({ status: 'ok', ...result });
    } catch (error) {
      // Body stays generic: nested errors may carry connection details.
      console.log(JSON.stringify({ event: 'http_run_failed', error: String(error) }));
      return Response.json({ status: 'failed' }, { status: 500 });
    }
  },
};
