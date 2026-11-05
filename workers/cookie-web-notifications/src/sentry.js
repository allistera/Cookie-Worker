import {
  captureHandledException as captureShared,
  createSentryOptions as createSharedOptions,
} from '../../../shared/sentry.js';

const SERVICE = 'cookie-web-notifications';

/**
 * Every secret-bearing binding this Worker's handlers accept, in one place so
 * `withSentry` and the handlers agree on the environment they are given.
 *
 * @typedef {Env & {
 *   SENTRY_DSN?: string,
 *   AUTH0_DOMAIN?: string,
 *   AUTH0_AUDIENCE?: string,
 *   NTFY_TOKEN_ENCRYPTION_KEY?: string,
 * }} NotificationsEnv
 */

/**
 * Auth0's domain/audience are public identifiers, already shipped in
 * Cookie-Web's own client bundle, but the Hyperdrive connection string
 * carries the database password and NTFY_TOKEN_ENCRYPTION_KEY unlocks every
 * stored ntfy access token, so both get scrubbed like every other Worker's.
 *
 * @param {NotificationsEnv} env
 * @returns {(string | undefined)[]}
 */
function secrets(env) {
  return [env.HYPERDRIVE.connectionString, env.NTFY_TOKEN_ENCRYPTION_KEY];
}

/**
 * @param {NotificationsEnv} env
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
 * @param {NotificationsEnv} env
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(operation, err, env, extra = {}) {
  captureShared(SERVICE, operation, err, secrets(env), extra);
}
