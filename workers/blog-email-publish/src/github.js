// Commits one new file through GitHub's REST contents API. The commit lands on
// the repository's default branch, authored by the token's owner.

import { fetchWithTimeout, readTextCapped } from '../../../shared/fetch.js';

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
// GitHub rejects requests that carry no User-Agent.
const USER_AGENT = 'blog-email-publish';
const MAX_ERROR_BODY_BYTES = 4096;

/** @param {string} text */
function toBase64(text) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class GitHubError extends Error {
  /**
   * @param {string} step
   * @param {number} status
   * @param {string} detail
   */
  constructor(step, status, detail) {
    super(`GitHub ${step} responded ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'GitHubError';
    this.status = status;
  }

  /** Worth another delivery attempt: GitHub was busy or broken, not refusing. */
  get transient() {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * @param {Response} response
 * @param {string} step
 */
async function failure(response, step) {
  const body = await readTextCapped(response, MAX_ERROR_BODY_BYTES).catch(() => '');
  let detail = '';
  try {
    detail = String(JSON.parse(body).message ?? '');
  } catch {
    // Not JSON (a proxy's error page); the status says enough.
  }
  return new GitHubError(step, response.status, detail);
}

/**
 * Creates `path` in `repository`, never replacing a file that is already
 * there: an article that exists was written on purpose.
 *
 * @param {{repository: string, path: string, content: string, message: string, token: string}} file
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<'created' | 'exists'>}
 */
export async function createFile({ repository, path, content, message, token }, fetchImpl = fetch) {
  const url = `${API_ROOT}/repos/${repository}/contents/${path}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  };

  const exists = await fetchWithTimeout(
    url,
    { method: 'GET', headers },
    async (response) => {
      if (response.status === 404) return false;
      if (!response.ok) throw await failure(response, 'lookup');
      await response.body?.cancel();
      return true;
    },
    undefined,
    fetchImpl,
  );
  if (exists) return 'exists';

  await fetchWithTimeout(
    url,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: toBase64(content) }),
    },
    async (response) => {
      if (!response.ok) throw await failure(response, 'commit');
      await response.body?.cancel();
    },
    undefined,
    fetchImpl,
  );
  return 'created';
}
