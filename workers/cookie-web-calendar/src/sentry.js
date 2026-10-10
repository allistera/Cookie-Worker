import {
  captureHandledException as captureShared,
  createSentryOptions as createSharedOptions,
} from '../../../shared/sentry.js';

const SERVICE = 'cookie-web-calendar';

/**
 * Every secret-bearing binding this Worker's handlers accept, in one place so
 * `withSentry` and the handlers agree on the environment they are given.
 *
 * @typedef {Env & {
 *   SENTRY_DSN?: string,
 *   AUTH0_DOMAIN?: string,
 *   AUTH0_AUDIENCE?: string,
 *   OPENAI_API_KEY?: string,
 *   OPENAI_CALENDAR_MODEL?: string,
 *   CALENDAR_SUBSCRIPTION_ALLOWLIST?: string,
 *   GOOGLE_CLIENT_ID?: string,
 *   GOOGLE_CLIENT_SECRET?: string,
 *   GOOGLE_TOKEN_ENCRYPTION_KEY?: string,
 * }} CalendarEnv
 */

/**
 * The Hyperdrive connection string carries the database password;
 * OPENAI_API_KEY, the Google OAuth client secret and the key that encrypts
 * stored Google tokens are real secrets — all get scrubbed from anything that
 * reaches Sentry.
 *
 * @param {CalendarEnv} env
 * @returns {(string | undefined)[]}
 */
function secrets(env) {
  return [
    env.HYPERDRIVE.connectionString,
    env.OPENAI_API_KEY,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_TOKEN_ENCRYPTION_KEY,
  ];
}

/**
 * @param {CalendarEnv} env
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
 * @param {CalendarEnv} env
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(operation, err, env, extra = {}) {
  captureShared(SERVICE, operation, err, secrets(env), extra);
}
