import {
  captureHandledException as captureShared,
  createSentryOptions as createSharedOptions,
  redact as redactShared,
} from '../../../shared/sentry.js';

const SERVICE = 'blog-email-publish';

/**
 * Every secret-bearing binding this Worker's handler accepts, in one place so
 * `withSentry` and the handler agree on the environment they are given.
 *
 * @typedef {Env & {
 *   SENTRY_DSN?: string,
 *   BLOG_GITHUB_TOKEN?: string,
 * }} PublishEnv
 */

/**
 * @param {PublishEnv} env
 * @returns {import('@sentry/cloudflare').CloudflareOptions}
 */
export function createSentryOptions(env) {
  return createSharedOptions({ service: SERVICE, env, trigger: 'email' });
}

/**
 * Report a failure this Worker catches on purpose: an email that cannot become
 * an article is accepted rather than bounced, so Sentry is where it shows.
 * Uncaught failures are captured by the `withSentry` wrapper instead.
 *
 * @param {string} operation
 * @param {unknown} err
 * @param {PublishEnv} env
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(operation, err, env, extra = {}) {
  captureShared(SERVICE, operation, err, [env.BLOG_GITHUB_TOKEN], extra);
}

/**
 * @param {unknown} err
 * @param {PublishEnv} env
 */
export function redact(err, env) {
  return redactShared(err, env.BLOG_GITHUB_TOKEN);
}
