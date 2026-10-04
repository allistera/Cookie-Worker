// Identity for requests that reach a Worker through its `Internal` service
// binding entrypoint (shared/internal-entrypoint.js) rather than over HTTP.
// The MCP Worker has already verified the caller's own token; the bound
// Worker runs its ordinary fetch handler inside this scope, and
// verifyAccessToken returns the scoped identity instead of reading a JWT.
//
// AsyncLocalStorage rather than a header or a WeakMap keyed on the Request:
// nothing an HTTP client sends can enter the scope, and it survives the
// Sentry and metrics wrappers whether or not they pass the same Request on.

/// <reference path="./async-hooks.d.ts" />
import { AsyncLocalStorage } from 'node:async_hooks';

/** @typedef {{userId: string, email: string}} InternalIdentity */

/** @type {AsyncLocalStorage<InternalIdentity>} */
const scope = new AsyncLocalStorage();

/**
 * @template T
 * @param {InternalIdentity} identity
 * @param {() => T} callback
 * @returns {T}
 */
export function runAsInternalCaller(identity, callback) {
  const userId = typeof identity?.userId === 'string' ? identity.userId : '';
  const email = typeof identity?.email === 'string' ? identity.email : '';
  if (!userId || !email) throw new TypeError('Internal identity needs a userId and email');
  return scope.run(Object.freeze({ userId, email }), callback);
}

/** @returns {InternalIdentity | undefined} */
export function internalCaller() {
  return scope.getStore();
}
