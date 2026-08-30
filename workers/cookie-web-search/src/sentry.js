import {
  captureHandledException as captureShared,
  createSentryOptions as createSharedOptions,
} from '../../../shared/sentry.js';

const SERVICE = 'cookie-web-search';

/**
 * Every secret-bearing binding this Worker's handlers accept, in one place so
 * `withSentry` and the handlers agree on the environment they are given.
 *
 * @typedef {Env & {
 *   SENTRY_DSN?: string,
 *   AUTH0_DOMAIN?: string,
 *   AUTH0_AUDIENCE?: string,
 *   OPENAI_API_KEY?: string,
 *   OPENAI_ASK_MODEL?: string,
 *   MEILISEARCH_URL?: string,
 *   MEILISEARCH_INDEX?: string,
 *   MEILISEARCH_API_KEY?: string,
 * }} SearchEnv
 */

/**
 * The Hyperdrive connection string carries the database password and
 * OPENAI_API_KEY is a real secret — both get scrubbed from anything that
 * reaches Sentry.
 *
 * @param {SearchEnv} env
 * @returns {(string | undefined)[]}
 */
function secrets(env) {
  return [env.HYPERDRIVE.connectionString, env.OPENAI_API_KEY, env.MEILISEARCH_API_KEY];
}

/**
 * @param {SearchEnv} env
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
 * @param {SearchEnv} env
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(operation, err, env, extra = {}) {
  captureShared(SERVICE, operation, err, secrets(env), extra);
}
