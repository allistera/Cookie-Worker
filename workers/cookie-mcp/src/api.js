const BINDINGS = /** @type {const} */ ({
  emails: 'EMAILS',
  messages: 'MESSAGES',
  labels: 'LABELS',
  search: 'SEARCH',
  drafts: 'DRAFTS',
  send: 'SEND',
  calendar: 'CALENDAR',
  tasks: 'TASKS',
});

export class ApiError extends Error {
  /** @param {string} service @param {number} status @param {string} message */
  constructor(service, status, message) {
    super(message);
    this.name = 'ApiError';
    this.service = service;
    this.status = status;
  }
}

/**
 * @typedef {Record<string, string | number | boolean | undefined | null>} Query
 * @typedef {{
 *   get(path: string, query?: Query): Promise<any>,
 *   post(path: string, body?: unknown): Promise<any>,
 *   patch(path: string, body?: unknown): Promise<any>,
 *   delete(path: string, body?: unknown): Promise<any>,
 * }} ServiceCaller
 * @typedef {Record<keyof typeof BINDINGS, ServiceCaller>} Api
 */

/** @param {string} path @param {Query} [query] */
function withQuery(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/**
 * Per-service callers over the API Workers' Internal entrypoints. The
 * identity travels as plain RPC data; the client's bearer token never leaves
 * this Worker.
 *
 * @param {any} env
 * @param {{userId: string, email: string}} identity
 * @returns {Api}
 */
export function createApi(env, identity) {
  /** @param {keyof typeof BINDINGS} service */
  function caller(service) {
    /** @param {string} method @param {string} path @param {unknown} [body] */
    async function request(method, path, body) {
      const { status, body: payload } = await env[BINDINGS[service]].call(identity, {
        method,
        path,
        body,
      });
      if (status >= 200 && status < 300) return payload;
      const message =
        payload && typeof payload === 'object' && typeof payload.error === 'string'
          ? payload.error
          : `Request failed with status ${status}`;
      throw new ApiError(service, status, message);
    }
    /** @type {ServiceCaller} */
    return {
      get: (path, query) => request('GET', withQuery(path, query)),
      post: (path, body) => request('POST', path, body),
      patch: (path, body) => request('PATCH', path, body),
      delete: (path, body) => request('DELETE', path, body),
    };
  }
  return /** @type {Api} */ (
    Object.fromEntries(
      Object.keys(BINDINGS).map((service) => [service, caller(/** @type {any} */ (service))]),
    )
  );
}
