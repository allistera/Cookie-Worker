import {
  captureHandledException as captureShared,
  createSentryOptions as createSharedOptions,
  redact as redactShared,
} from '../../../shared/sentry.js';

export { tagTrigger } from '../../../shared/sentry.js';

const SERVICE = 'scheduled-send-flusher';

/**
 * Every secret-bearing binding this Worker's handlers accept, in one place so
 * `withSentry` and the handlers agree on the environment they are given.
 *
 * @typedef {Env & {
 *   SENTRY_DSN?: string,
 *   COOKIE_WEB_FLUSH_URL?: string,
 *   COOKIE_WEB_FLUSH_TOKEN?: string,
 *   HTTP_TRIGGER_TOKEN?: string,
 * }} FlusherEnv
 */

/**
 * Both bearer secrets this Worker handles: Cookie-Web echoes request details
 * back in some error responses, and an upstream failure should never turn
 * into a Sentry issue containing the token that authenticated it.
 *
 * @param {FlusherEnv} env
 * @returns {(string | undefined)[]}
 */
function secrets(env) {
  return [env.COOKIE_WEB_FLUSH_TOKEN, env.HTTP_TRIGGER_TOKEN];
}

/**
 * @param {FlusherEnv} env
 * @returns {import('@sentry/cloudflare').CloudflareOptions}
 */
export function createSentryOptions(env) {
  return createSharedOptions({ service: SERVICE, env });
}

/**
 * Report a failure this Worker catches on purpose. Uncaught failures are
 * captured by the `withSentry` wrapper instead.
 *
 * @param {string} operation
 * @param {unknown} err
 * @param {FlusherEnv} env
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(operation, err, env, extra = {}) {
  captureShared(SERVICE, operation, err, secrets(env), extra);
}

/**
 * @param {unknown} err
 * @param {FlusherEnv} env
 */
export function redact(err, env) {
  return redactShared(err, ...secrets(env));
}
