import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  captureException: vi.fn(),
  withSentry: vi.fn((_options, handler) => handler),
}));

/** @type {any} */
const sentry = await import('@sentry/cloudflare');
const { default: worker, MAX_PARSE_BYTES } = await import('../src/worker.js');
const { createSentryOptions } = await import('../src/sentry.js');

const TOKEN = 'github-secret-token';
const env = /** @type {any} */ ({
  ALLOWED_SENDER: 'me@example.com',
  BLOG_REPOSITORY: 'owner/blog',
  BLOG_GITHUB_TOKEN: TOKEN,
  SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
});

const DMARC_PASS =
  'mx.cloudflare.net;\tdkim=pass header.d=example.com header.s=resend header.b=abc;\tdmarc=pass header.from=example.com policy.dmarc=reject;\tspf=pass smtp.mailfrom=bounce@send.example.com';

/**
 * @param {{from?: string, subject?: string, verdict?: string | null, body?: string}} [options]
 */
function rawEmail({
  from = 'Me <me@example.com>',
  subject = 'My First Emailed Post',
  verdict = DMARC_PASS,
  body = '<div>Hello <b>blog</b>.</div>',
} = {}) {
  return [
    'Received: from mail.example.com by mx.cloudflare.net',
    ...(verdict ? [`Authentication-Results: ${verdict}`] : []),
    `From: ${from}`,
    'To: blog@example.com',
    `Subject: ${subject}`,
    'Message-ID: <post-1@example.com>',
    'Date: Tue, 17 Nov 2026 15:30:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n');
}

/**
 * @param {string} raw
 * @param {{rawSize?: number}} [options]
 * @returns {any}
 */
function fakeMessage(raw, options = {}) {
  return {
    from: 'bounce@send.example.com',
    to: 'blog@example.com',
    raw,
    rawSize: options.rawSize ?? new TextEncoder().encode(raw).byteLength,
    setReject: vi.fn(),
  };
}

/** @param {string} base64 */
function decode(base64) {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
}

const json = (/** @type {unknown} */ body, /** @type {number} */ status) =>
  new Response(JSON.stringify(body), { status });

const fetchMock = vi.fn();

/** Everything the handler logged, one string per line. */
function logged() {
  return [console.log, console.error]
    .flatMap((log) => /** @type {any} */ (log).mock.calls)
    .map((/** @type {any[]} */ call) => call[0])
    .join('\n');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T15:31:00Z'));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('publishing', () => {
  test('commits the email as a Markdown article', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({}, 201));
    const message = fakeMessage(rawEmail());

    await worker.email(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    const [url, request] = fetchMock.mock.calls[1];
    expect(url).toBe(
      'https://api.github.com/repos/owner/blog/contents/src/content/blog/my-first-emailed-post.md',
    );
    expect(request.method).toBe('PUT');
    const body = JSON.parse(request.body);
    expect(body.message).toBe('Publish "My First Emailed Post" from email');
    expect(decode(body.content)).toBe(
      [
        '---',
        'title: "My First Emailed Post"',
        'description: "Hello blog."',
        'pubDate: 2026-11-17T15:31:00Z',
        'tags: []',
        'draft: false',
        '---',
        '',
        'Hello **blog**.',
        '',
      ].join('\n'),
    );
    expect(logged()).toContain('"event":"published"');
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  test('accepts and reports an article whose title is already taken', async () => {
    fetchMock.mockResolvedValueOnce(json({ sha: 'abc' }, 200));
    const message = fakeMessage(rawEmail());

    await worker.email(message, env);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(message.setReject).not.toHaveBeenCalled();
    expect(sentry.captureException.mock.calls[0][0]).toMatchObject({
      message: 'An article with this title already exists',
    });
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { service: 'blog-email-publish', operation: 'commit_article' },
      extra: { reason: 'exists', path: 'src/content/blog/my-first-emailed-post.md' },
    });
  });
});

describe('senders', () => {
  test.each([
    ['someone else', rawEmail({ from: 'stranger@example.org' }), 'sender_not_allowed'],
    [
      'a From header that failed DMARC',
      rawEmail({ verdict: 'mx.cloudflare.net; dmarc=fail header.from=example.com' }),
      'unauthenticated',
    ],
    ['a message with no verdict from Cloudflare', rawEmail({ verdict: null }), 'unauthenticated'],
  ])('rejects %s without touching GitHub', async (_name, raw, reason) => {
    const message = fakeMessage(raw);

    await worker.email(message, env);

    expect(message.setReject).toHaveBeenCalledWith('This address only accepts mail from its owner');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged()).toContain(`"reason":"${reason}"`);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  test('ignores a verdict the sender wrote below the real one', async () => {
    const raw = rawEmail({
      verdict: 'mx.cloudflare.net; dmarc=fail header.from=example.com',
    }).replace('From:', `Authentication-Results: ${DMARC_PASS}\r\nFrom:`);
    const message = fakeMessage(raw);

    await worker.email(message, env);

    expect(message.setReject).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('emails that cannot be published', () => {
  // Cookie's own calendar replies and out-of-office answers leave from the
  // owner's address with a DMARC pass; neither may become an article.
  test.each([
    [
      'an automatic reply',
      rawEmail().replace('MIME-Version:', 'Auto-Submitted: auto-replied\r\nMIME-Version:'),
      'auto_submitted',
    ],
    [
      'a calendar reply',
      rawEmail()
        .replace(
          'Content-Type: text/html; charset=utf-8',
          'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/html; charset=utf-8',
        )
        .replace(
          '<div>Hello <b>blog</b>.</div>\r\n',
          '<div>Accepted</div>\r\n--b\r\nContent-Type: text/calendar; method=REPLY; charset=utf-8\r\n\r\nBEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR\r\n--b--\r\n',
        ),
      'calendar',
    ],
  ])('accepts without publishing %s from the owner', async (_name, raw, reason) => {
    const message = fakeMessage(raw);

    await worker.email(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged()).toContain(`"reason":"${reason}"`);
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { operation: 'read_email' },
      extra: { reason },
    });
  });

  test.each([
    ['no subject', rawEmail({ subject: '' }), 'missing_title'],
    ['no content', rawEmail({ body: '<div><br></div>' }), 'empty_body'],
  ])('accepts and reports an email with %s', async (_name, raw, reason) => {
    const message = fakeMessage(raw);

    await worker.email(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { operation: 'build_article' },
      extra: { reason },
    });
  });

  test('does not read a message too large to be an article', async () => {
    const message = fakeMessage(rawEmail(), { rawSize: MAX_PARSE_BYTES + 1 });

    await worker.email(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sentry.captureException.mock.calls[0][0]).toMatchObject({
      message: 'Email is too large',
    });
  });
});

describe('GitHub failures', () => {
  test('accepts the email and reports a refusal, keeping the token out', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ message: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({ message: `Bad credentials for ${TOKEN}` }, 401));
    const message = fakeMessage(rawEmail());

    await worker.email(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    const reported = sentry.captureException.mock.calls[0][0];
    expect(reported.message).toBe('GitHub commit responded 401: Bad credentials for [redacted]');
    expect(logged()).toContain('publish_failed');
    expect(logged()).not.toContain(TOKEN);
  });

  test('throws when GitHub is unavailable so the message is delivered again', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Service unavailable' }, 503));

    await expect(worker.email(fakeMessage(rawEmail()), env)).rejects.toThrow(
      'GitHub lookup responded 503: Service unavailable',
    );
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  test('throws on a network failure so the message is delivered again', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(worker.email(fakeMessage(rawEmail()), env)).rejects.toThrow('fetch failed');
  });

  test('accepts and reports an email when the token is not configured', async () => {
    const message = fakeMessage(rawEmail());

    await worker.email(message, { ...env, BLOG_GITHUB_TOKEN: undefined });

    expect(message.setReject).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sentry.captureException.mock.calls[0][0]).toMatchObject({
      message: 'BLOG_GITHUB_TOKEN is not configured',
    });
  });
});

describe('Sentry configuration', () => {
  test('tags the service and trigger and keeps personal data out', () => {
    const options = createSentryOptions(env);

    expect(options).toMatchObject({
      enabled: true,
      environment: 'production',
      tracesSampleRate: 0,
    });
    expect(options.beforeSend?.(/** @type {any} */ ({ user: { id: 'u' } }), {})).toMatchObject({
      user: undefined,
      transaction: 'blog-email-publish.email',
      tags: { service: 'blog-email-publish', trigger: 'email' },
    });
  });
});
