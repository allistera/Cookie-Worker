import {
  captureHandledException as captureShared,
  createSentryOptions as createSharedOptions,
} from '../../../shared/sentry.js';

export { redact } from '../../../shared/sentry.js';

const SERVICE = 'mail-app-ingest';

// Cloudflare's message.forward() surfaces upstream SMTP temp-fails as
// "could not send email: ... transient error (4xx): ...". The handler
// rethrows these on purpose so the sending MTA retries delivery.
const TRANSIENT_FORWARD_ERROR = /^could not send email:.*transient error \(4\d\d\)/isu;

/**
 * @param {unknown} err
 */
export function isTransientForwardError(err) {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return TRANSIENT_FORWARD_ERROR.test(text);
}

/**
 * Shared private-by-default options, plus the one filter specific to mail:
 * intentional rethrows for MTA retry are not crashes.
 *
 * @param {Env & {SENTRY_DSN?: string}} env
 * @returns {import('@sentry/cloudflare').CloudflareOptions}
 */
export function createSentryOptions(env) {
  return createSharedOptions({
    service: SERVICE,
    env,
    trigger: 'email',
    beforeSend(event) {
      // The handler intentionally rethrows transient forward errors so the
      // sending MTA retries; those are expected operations noise, not crashes.
      // They stay visible as forward_failed_transient structured logs.
      const unhandledTransientForward = event.exception?.values?.some((value) => (
        value.mechanism?.handled === false
        && isTransientForwardError(value.value ?? '')
      ));
      return unhandledTransientForward ? null : event;
    },
  });
}

/**
 * Report failures that the forwarding-first handler intentionally catches.
 * The Sentry wrapper captures uncaught failures automatically.
 *
 * @param {string} operation
 * @param {unknown} err
 * @param {(string | undefined)[]} [secrets]
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(operation, err, secrets = [], extra = {}) {
  captureShared(SERVICE, operation, err, secrets, extra);
}
