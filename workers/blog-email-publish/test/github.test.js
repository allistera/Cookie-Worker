import { describe, expect, test, vi } from 'vitest';
import { createFile, GitHubError } from '../src/github.js';

const file = {
  repository: 'owner/blog',
  path: 'src/content/blog/hello.md',
  content: 'Héllo — wörld\n',
  message: 'Publish "Hello" from email',
  token: 'github-secret',
};

/** @param {...Response} responses */
function fetchReturning(...responses) {
  const fetchImpl = vi.fn();
  for (const response of responses) fetchImpl.mockResolvedValueOnce(response);
  return /** @type {any} */ (fetchImpl);
}

/** @param {string} base64 */
function decode(base64) {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

const json = (/** @type {unknown} */ body, /** @type {number} */ status) =>
  new Response(JSON.stringify(body), { status });

describe('createFile', () => {
  test('commits a new file as base64 UTF-8', async () => {
    const fetchImpl = fetchReturning(json({ message: 'Not Found' }, 404), json({}, 201));

    await expect(createFile(file, fetchImpl)).resolves.toBe('created');

    const [lookupUrl, lookup] = fetchImpl.mock.calls[0];
    expect(lookupUrl).toBe(
      'https://api.github.com/repos/owner/blog/contents/src/content/blog/hello.md',
    );
    expect(lookup.method).toBe('GET');
    expect(lookup.headers).toMatchObject({
      Authorization: 'Bearer github-secret',
      'User-Agent': 'blog-email-publish',
      'X-GitHub-Api-Version': '2022-11-28',
    });

    const [commitUrl, commit] = fetchImpl.mock.calls[1];
    expect(commitUrl).toBe(lookupUrl);
    expect(commit.method).toBe('PUT');
    const body = JSON.parse(commit.body);
    expect(body.message).toBe('Publish "Hello" from email');
    expect(decode(body.content)).toBe('Héllo — wörld\n');
    // No blob SHA: GitHub then refuses to replace a file that appeared meanwhile.
    expect(body).not.toHaveProperty('sha');
  });

  test('leaves an existing file alone', async () => {
    const fetchImpl = fetchReturning(json({ sha: 'abc' }, 200));

    await expect(createFile(file, fetchImpl)).resolves.toBe('exists');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test("reports a refused commit as permanent, with GitHub's reason", async () => {
    const fetchImpl = fetchReturning(
      json({ message: 'Not Found' }, 404),
      json({ message: 'Resource not accessible by personal access token' }, 403),
    );

    const error = await createFile(file, fetchImpl).catch((err) => err);

    expect(error).toBeInstanceOf(GitHubError);
    expect(error.message).toBe(
      'GitHub commit responded 403: Resource not accessible by personal access token',
    );
    expect(error.transient).toBe(false);
  });

  test.each([429, 500, 503])('marks a %i as worth retrying', async (status) => {
    const fetchImpl = fetchReturning(new Response('<html>busy</html>', { status }));

    const error = await createFile(file, fetchImpl).catch((err) => err);

    expect(error).toBeInstanceOf(GitHubError);
    expect(error.message).toBe(`GitHub lookup responded ${status}`);
    expect(error.transient).toBe(true);
  });
});
