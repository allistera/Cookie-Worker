// Every Worker reports the same way: a private-by-default client, one
// `service` tag so a single Sentry project stays readable, and secrets
// scrubbed out of messages and stack traces before anything leaves the
// isolate. Workers layer their own filtering on top through `beforeSend`.

import * as Sentry from '@sentry/cloudflare';
import { sanitizeMetric } from './applicationMetrics.js';
import { recordHandledError } from './tracing.js';

/**
 * @typedef {{SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string}} SentryEnv
 */

/**
 * Keep error monitoring useful without sending request bodies, headers, user
 * identity, cookies, or stack-frame local variables to Sentry.
 *
 * @param {object} config
 * @param {string} config.service Worker name, sent as the `service` tag.
 * @param {SentryEnv} config.env
 * @param {string} [config.trigger] Only for single-trigger Workers: tags every
 *   event and renames the transaction. Workers with several triggers leave it
 *   unset and tag each invocation instead (see {@link tagTrigger}).
 * @param {(event: import('@sentry/core').ErrorEvent, hint: import('@sentry/core').EventHint) => import('@sentry/core').ErrorEvent | null} [config.beforeSend]
 *   Runs before the shared scrubbing; return null to drop the event.
 * @returns {import('@sentry/cloudflare').CloudflareOptions}
 */
export function createSentryOptions({ service, env, trigger, beforeSend }) {
  return {
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.SENTRY_ENVIRONMENT ?? 'production',
    tracesSampleRate: 0,
    beforeSendMetric: (metric) => sanitizeMetric(metric, service),
    // SDK v11 turned this on by default; keep non-Error throws without a
    // synthetic call-site stack, as in v10, so issue grouping stays stable.
    attachStacktrace: false,
    // Every category is listed on purpose: an omitted one falls back to the
    // SDK default, which collects it.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend(event, hint) {
      // A `wrangler dev` session with a DSN in .dev.vars inherits the
      // deployed SENTRY_ENVIRONMENT, and reported a missing local key as a
      // production failure (Sentry COOKIE-WEB-1B). Nothing local belongs in
      // the project at all, whatever the tag says.
      if (isLocalDevEvent(event)) return null;
      const filtered = beforeSend ? beforeSend(event, hint) : event;
      if (!filtered) return null;
      // A failure the wrapper caught itself still carries the driver's error;
      // a handled one was tagged by captureHandledException already.
      const dbCode = databaseErrorCode(hint?.originalException);
      return {
        ...filtered,
        ...(trigger ? { transaction: `${service}.${trigger}` } : {}),
        request: undefined,
        user: undefined,
        breadcrumbs: undefined,
        tags: {
          ...(dbCode ? { [DB_ERROR_TAG]: dbCode } : {}),
          ...filtered.tags,
          service,
          ...(trigger ? { trigger } : {}),
        },
      };
    },
  };
}

// Sentry tag carrying the SQLSTATE or driver code of a database failure, so
// issues can be filtered and alerted on by class (08 connection, 53
// resources, 57014 statement timeout, 40P01 deadlock) without opening them.
export const DB_ERROR_TAG = 'db.error_code';

// postgres.js raises these itself when the socket never came up or dropped.
const DRIVER_ERROR_CODES = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
]);

/**
 * The code of an error that came from the database or its driver: a SQLSTATE
 * on a server error (which also carries a severity), or one of the driver's
 * connection codes. Undefined for everything else, so an unrelated five-letter
 * `code` such as EPIPE is not mistaken for a SQLSTATE.
 *
 * @param {unknown} err
 * @returns {string | undefined}
 */
export function databaseErrorCode(err) {
  const { code, severity, name } =
    /** @type {{code?: unknown, severity?: unknown, name?: unknown}} */ (err ?? {});
  if (typeof code !== 'string') return undefined;
  if (DRIVER_ERROR_CODES.has(code)) return code;
  const fromServer = name === 'PostgresError' || typeof severity === 'string';
  return fromServer && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;
}

// Wrangler builds every `wrangler dev` bundle under .wrangler/tmp; a deployed
// Worker's frames never point there.
const LOCAL_DEV_BUNDLE = /[\\/]\.wrangler[\\/]tmp[\\/]/u;

/**
 * Whether the event's stack trace comes from a local development bundle.
 *
 * @param {import('@sentry/core').ErrorEvent} event
 */
export function isLocalDevEvent(event) {
  return Boolean(
    event.exception?.values?.some((value) =>
      value.stacktrace?.frames?.some(
        (frame) =>
          LOCAL_DEV_BUNDLE.test(frame.abs_path ?? '') ||
          LOCAL_DEV_BUNDLE.test(frame.filename ?? ''),
      ),
    ),
  );
}

/**
 * Tag the current invocation for Workers that answer more than one trigger,
 * so a cron failure and a manual `POST /run` failure stay distinguishable.
 *
 * @param {string} trigger
 */
export function tagTrigger(trigger) {
  Sentry.setTag('trigger', trigger);
}

/**
 * Report a failure the Worker deliberately caught. The `withSentry` wrapper
 * only sees what escapes a handler, and these never do. The same scrubbed
 * error is attached to the invocation's trace span, so a request that went
 * on after a failed step still shows what failed.
 *
 * @param {string} service
 * @param {string} operation
 * @param {unknown} err
 * @param {(string | undefined)[]} [secrets]
 * @param {Record<string, unknown>} [extra]
 */
export function captureHandledException(service, operation, err, secrets = [], extra = {}) {
  const safeError = sanitizeError(err, secrets);
  const dbCode = databaseErrorCode(err);
  // The sanitised copy drops everything but name, message and stack; the
  // code is put back so the trace span's error.type is the SQLSTATE too.
  if (dbCode) Object.assign(safeError, { code: dbCode });
  recordHandledError(safeError, operation);
  Sentry.captureException(safeError, {
    tags: {
      service,
      operation,
      ...(dbCode ? { [DB_ERROR_TAG]: dbCode } : {}),
    },
    extra,
  });
}

/**
 * Report a condition the Worker detected without an exception, such as a feed
 * that has gone quiet. The fingerprint groups every occurrence of one condition
 * into one issue, so keep `message` fixed and put the variable detail in `extra`.
 *
 * @param {string} service
 * @param {string} operation
 * @param {string} message
 * @param {{fingerprint: string[], extra?: Record<string, unknown>}} options
 */
export function captureHandledMessage(service, operation, message, { fingerprint, extra = {} }) {
  Sentry.captureMessage(message, {
    level: 'error',
    fingerprint,
    tags: { service, operation },
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
