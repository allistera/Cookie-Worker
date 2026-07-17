import * as Sentry from '@sentry/cloudflare';

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
 * Keep error monitoring useful without sending email bodies, headers, user
 * identity, cookies, or stack-frame local variables to Sentry.
 *
 * @param {Env & {SENTRY_DSN?: string}} env
 * @returns {import('@sentry/cloudflare').CloudflareOptions}
 */
export function createSentryOptions(env) {
  return {
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.SENTRY_ENVIRONMENT ?? 'production',
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
    },
    beforeSend(event) {
      // The handler intentionally rethrows transient forward errors so the
      // sending MTA retries; those are expected operations noise, not crashes.
      // They stay visible as forward_failed_transient structured logs.
      const unhandledTransientForward = event.exception?.values?.some((value) => (
        value.mechanism?.handled === false
        && isTransientForwardError(value.value ?? '')
      ));
      if (unhandledTransientForward) return null;
      return {
        ...event,
        transaction: `${SERVICE}.email`,
        request: undefined,
        user: undefined,
        breadcrumbs: undefined,
        tags: {
          ...event.tags,
          service: SERVICE,
          trigger: 'email',
        },
      };
    },
  };
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
  Sentry.captureException(sanitizeError(err, secrets), {
    tags: {
      service: SERVICE,
      operation,
    },
    extra,
  });
}

/**
 * @param {unknown} err
 * @param {...(string | undefined)} secrets
 */
export function redact(err, ...secrets) {
  return redactText(err instanceof Error ? err.message : String(err), secrets);
}

/**
 * Preserve the useful stack while removing connection strings and API keys.
 * @param {unknown} err
 * @param {(string | undefined)[]} secrets
 */
function sanitizeError(err, secrets) {
  const safeError = new Error(redact(err, ...secrets));
  if (err instanceof Error) {
    safeError.name = err.name;
    if (err.stack) safeError.stack = redactText(err.stack, secrets);
  }
  return safeError;
}

/**
 * @param {string} text
 * @param {(string | undefined)[]} secrets
 */
function redactText(text, secrets) {
  let redacted = text;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}
