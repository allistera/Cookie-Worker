import * as Sentry from '@sentry/cloudflare';
import PostalMime from 'postal-mime';
import { withApplicationMetrics } from '../../../shared/applicationMetrics.js';
import { ArticleError, buildArticle } from './article.js';
import { createFile, GitHubError } from './github.js';
import { checkSender } from './sender.js';
import { captureHandledException, createSentryOptions, redact } from './sentry.js';

// An article is text. Anything near this size is attachments, which are not
// published, so the message is not read at all.
export const MAX_PARSE_BYTES = 10 * 1024 * 1024;

/** @typedef {import('./sentry.js').PublishEnv} PublishEnv */

/**
 * Mail from the allowed sender is always accepted, published or not. Bouncing
 * it would be answered by the sending service suppressing this address, and
 * every later article would then be dropped before it left. What could not be
 * published is reported to Sentry instead. Only a failure that another
 * attempt can fix is thrown, so the sending server delivers the message again.
 *
 * @param {string} event
 * @param {string} operation
 * @param {unknown} err
 * @param {PublishEnv} env
 * @param {Record<string, unknown>} [detail]
 */
function reportUnpublished(event, operation, err, env, detail = {}) {
  console.error(JSON.stringify({ event, error: redact(err, env), ...detail }));
  captureHandledException(operation, err, env, detail);
}

const worker = {
  /**
   * @param {ForwardableEmailMessage} message
   * @param {PublishEnv} env
   */
  async email(message, env) {
    const rawSize = message.rawSize ?? 0;
    if (rawSize > MAX_PARSE_BYTES) {
      reportUnpublished('publish_skipped', 'read_email', new Error('Email is too large'), env, {
        raw_size: rawSize,
      });
      return;
    }

    const email = await PostalMime.parse(message.raw);
    const sender = checkSender(email, env.ALLOWED_SENDER);
    if (sender !== 'authorised') {
      console.log(JSON.stringify({ event: 'sender_rejected', reason: sender }));
      message.setReject('This address only accepts mail from its owner');
      return;
    }

    let article;
    try {
      article = buildArticle(email, new Date());
    } catch (err) {
      if (!(err instanceof ArticleError)) throw err;
      reportUnpublished('publish_skipped', 'build_article', err, env, { reason: err.reason });
      return;
    }

    if (!env.BLOG_GITHUB_TOKEN) {
      const err = new Error('BLOG_GITHUB_TOKEN is not configured');
      reportUnpublished('publish_failed', 'commit_article', err, env, { path: article.path });
      return;
    }

    let outcome;
    try {
      outcome = await createFile({
        repository: env.BLOG_REPOSITORY,
        path: article.path,
        content: article.content,
        message: `Publish "${article.title}" from email`,
        token: env.BLOG_GITHUB_TOKEN,
      });
    } catch (err) {
      // A refusal (a bad token, a missing repository) fails the same way on
      // every redelivery. Everything else, including a timeout, is retried.
      if (!(err instanceof GitHubError) || err.transient) throw err;
      reportUnpublished('publish_failed', 'commit_article', err, env, { path: article.path });
      return;
    }

    if (outcome === 'exists') {
      const err = new Error('An article with this title already exists');
      reportUnpublished('publish_skipped', 'commit_article', err, env, {
        reason: 'exists',
        path: article.path,
      });
      return;
    }
    console.log(JSON.stringify({ event: 'published', path: article.path }));
  },
};

export default Sentry.withSentry(
  createSentryOptions,
  withApplicationMetrics(worker, 'blog-email-publish'),
);
