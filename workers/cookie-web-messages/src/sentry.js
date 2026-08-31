import {
  captureHandledException as captureShared,
  createSentryOptions as createSharedOptions,
} from '../../../shared/sentry.js';

const SERVICE = 'cookie-web-messages';

/**
 * Every secret-bearing binding this Worker's handlers accept, in one place
 * so `withSentry` and the handlers agree on the environment they are given.
 *
 * @typedef {Env & {
 *   SENTRY_DSN?: string,
 *   AUTH0_DOMAIN?: string,
 *   AUTH0_AUDIENCE?: string,
 *   BLOB_READ_WRITE_TOKEN?: string,
 *   RESEND_API_KEY?: string,
 *   EMAIL_FROM?: string,
 *   UNSUBSCRIBE_ONE_CLICK_ALLOWLIST?: string,
 *   MEILISEARCH_API_KEY?: string,
 * }} MessagesEnv
 */

/**
 * @param {MessagesEnv} env
 * @returns {(string | undefined)[]}
 */
function secrets(env) {
  return [
    env.HYPERDRIVE.connectionString,
    env.BLOB_READ_WRITE_TOKEN,
    env.RESEND_API_KEY,
    env.MEILISEARCH_API_KEY,
  ];
}

/**
 * @param {MessagesEnv} env
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
 * @param {MessagesEnv} env
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(operation, err, env, extra = {}) {
  captureShared(SERVICE, operation, err, secrets(env), extra);
}
