import {
  captureHandledException as captureShared,
  createSentryOptions as createSharedOptions,
} from '../../../shared/sentry.js';

const SERVICE = 'cookie-web-tasks';

/**
 * Every secret-bearing binding this Worker's handlers accept, in one place
 * so `withSentry` and the handlers agree on the environment they are given.
 *
 * @typedef {Env & {
 *   SENTRY_DSN?: string,
 *   AUTH0_DOMAIN?: string,
 *   AUTH0_AUDIENCE?: string,
 *   OPENAI_API_KEY?: string,
 *   ENRICHER_TRIGGER_TOKEN?: string,
 *   OWNER_EMAIL?: string,
 *   BLOB_READ_WRITE_TOKEN?: string,
 *   FILES?: R2Bucket,
 * }} TasksEnv
 */

/**
 * @param {TasksEnv} env
 * @returns {(string | undefined)[]}
 */
function secrets(env) {
  return [
    env.HYPERDRIVE.connectionString,
    env.OPENAI_API_KEY,
    env.ENRICHER_TRIGGER_TOKEN,
    env.BLOB_READ_WRITE_TOKEN,
  ];
}

/**
 * @param {TasksEnv} env
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
 * @param {TasksEnv} env
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(operation, err, env, extra = {}) {
  captureShared(SERVICE, operation, err, secrets(env), extra);
}
