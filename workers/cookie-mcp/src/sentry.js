import {
  captureHandledException as captureShared,
  createSentryOptions as createSharedOptions,
} from '../../../shared/sentry.js';

const SERVICE = 'cookie-mcp';

/**
 * Every secret-bearing binding this Worker's handlers accept, in one place so
 * `withSentry` and the handlers agree on the environment they are given.
 *
 * @typedef {Env & {
 *   SENTRY_DSN?: string,
 *   AUTH0_DOMAIN?: string,
 *   AUTH0_AUDIENCE?: string,
 *   MCP_RESOURCE?: string,
 * }} McpEnv
 */

/**
 * Auth0's domain/audience and the MCP resource are public identifiers, but
 * the Hyperdrive connection string carries the database password, so it still
 * gets scrubbed like every other Worker's does. Callers never pass tool
 * arguments or results as `extra`.
 *
 * @param {McpEnv} env
 * @returns {(string | undefined)[]}
 */
function secrets(env) {
  return [env.HYPERDRIVE.connectionString];
}

/**
 * @param {McpEnv} env
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
 * @param {McpEnv} env
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(operation, err, env, extra = {}) {
  captureShared(SERVICE, operation, err, secrets(env), extra);
}
