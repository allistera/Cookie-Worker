import {
  captureHandledException as captureShared,
  createSentryOptions as createSharedOptions,
} from '../../../shared/sentry.js';

const SERVICE = 'cookie-web-drafts';

/**
 * Every secret-bearing binding this Worker's handlers accept, in one place so
 * `withSentry` and the handlers agree on the environment they are given.
 *
 * @typedef {Env & {
 *   SENTRY_DSN?: string,
 *   AUTH0_DOMAIN?: string,
 *   AUTH0_AUDIENCE?: string,
 * }} DraftsEnv
 */

/**
 * Nothing this Worker holds is secret in the message-content sense (Auth0's
 * domain/audience are public identifiers, already shipped in Cookie-Web's own
 * client bundle), but the Hyperdrive connection string carries the database
 * password, so it still gets scrubbed like every other Worker's does.
 *
 * @param {DraftsEnv} env
 * @returns {(string | undefined)[]}
 */
function secrets(env) {
  return [env.HYPERDRIVE.connectionString];
}

/**
 * @param {DraftsEnv} env
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
 * @param {DraftsEnv} env
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(operation, err, env, extra = {}) {
  captureShared(SERVICE, operation, err, secrets(env), extra);
}
