import {
  captureHandledException as captureShared,
  createSentryOptions as createSharedOptions,
  redact as redactShared,
} from '../../../shared/sentry.js';

export { tagTrigger } from '../../../shared/sentry.js';

const SERVICE = 'data-enricher';

/**
 * Every secret-bearing binding this Worker's handlers accept, in one place so
 * `withSentry` and the handlers agree on the environment they are given.
 *
 * @typedef {Env & {
 *   SENTRY_DSN?: string,
 *   OPENAI_API_KEY?: string,
 *   GITHUB_API_TOKEN?: string,
 *   PRODUCT_HUNT_TOKEN?: string,
 *   HTTP_TRIGGER_TOKEN?: string,
 * }} EnricherEnv
 */

/**
 * Everything this Worker holds that must never reach a log line or Sentry:
 * the Hyperdrive connection string carries the database password, and a
 * failing upstream call happily echoes the token it was given back at us.
 *
 * @param {EnricherEnv} env
 * @returns {(string | undefined)[]}
 */
function secrets(env) {
  return [
    env.HYPERDRIVE.connectionString,
    env.OPENAI_API_KEY,
    env.GITHUB_API_TOKEN,
    env.PRODUCT_HUNT_TOKEN,
    env.HTTP_TRIGGER_TOKEN,
  ];
}

/**
 * @param {EnricherEnv} env
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
 * @param {EnricherEnv} env
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(operation, err, env, extra = {}) {
  captureShared(SERVICE, operation, err, secrets(env), extra);
}

/**
 * @param {unknown} err
 * @param {EnricherEnv} env
 */
export function redact(err, env) {
  return redactShared(err, ...secrets(env));
}
