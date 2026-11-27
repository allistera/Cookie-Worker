// Turns one email into one blog article: the subject is the title, the body
// is the content, and the front matter is what the blog's content schema
// (`src/content.config.ts` in the blog repository) requires.

import { fromHtml } from 'hast-util-from-html';
import { toMdast } from 'hast-util-to-mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';

// Where the blog keeps its articles. Plain `.md`, not `.mdx`: converted prose
// may hold `{` or `<`, which MDX would read as code.
const CONTENT_DIRECTORY = 'src/content/blog';
export const MAX_SLUG_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 160;

/** @typedef {ReturnType<typeof fromHtml>} HtmlTree */
/** @typedef {HtmlTree | HtmlTree['children'][number]} HtmlNode */
/** @typedef {ReturnType<typeof toMdast>} MarkdownNode */

/** An email that cannot become an article, whoever sent it. */
export class ArticleError extends Error {
  /** @param {'missing_title' | 'empty_body'} reason */
  constructor(reason) {
    super(`Email cannot be published: ${reason}`);
    this.name = 'ArticleError';
    this.reason = reason;
  }
}

/**
 * @param {string} title
 * @param {Date} now Names the article when the title has no letters or digits to use.
 */
export function slugify(title, now) {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/u, '');
  return slug || `post-${now.toISOString().slice(0, 10)}`;
}

/**
 * An image the article cannot show: one embedded in the email itself
 * (`cid:`, `data:`), which no reader of the blog can load, or a tracking
 * pixel such as the read receipt Cookie adds to sent mail.
 *
 * @param {HtmlNode} node
 */
function isUnusableImage(node) {
  if (node.type !== 'element' || node.tagName !== 'img') return false;
  const { src, width, height, style } = node.properties;
  if (!/^https?:\/\//iu.test(String(src ?? ''))) return true;
  if (Number(width) <= 1 || Number(height) <= 1) return true;
  return /display\s*:\s*none/iu.test(String(style ?? ''));
}

/** @param {HtmlNode} node */
function dropUnusableImages(node) {
  if (!('children' in node)) return;
  node.children = node.children.filter((child) => !isUnusableImage(child));
  node.children.forEach(dropUnusableImages);
}

/** @param {MarkdownNode} node */
function textOf(node) {
  if ('value' in node) return node.value;
  return 'children' in node ? node.children.map(textOf).join('') : '';
}

/**
 * A paragraph with nothing to read. Rich-text editors write a blank line as
 * an empty block (`<div><br></div>`), which would otherwise pile up as empty
 * paragraphs between the real ones.
 *
 * @param {MarkdownNode} node
 */
function isBlankParagraph(node) {
  if (node.type !== 'paragraph') return false;
  return node.children.every(
    (child) => child.type === 'break' || (child.type === 'text' && !child.value.trim()),
  );
}

/** @param {MarkdownNode} node */
function dropBlankParagraphs(node) {
  if (!('children' in node)) return;
  const children = /** @type {MarkdownNode[]} */ (node.children);
  const kept = children.filter((child) => !isBlankParagraph(child));
  children.splice(0, children.length, ...kept);
  kept.forEach(dropBlankParagraphs);
}

/** @param {string} text */
function describe(text) {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= MAX_DESCRIPTION_LENGTH) return collapsed;
  const cut = collapsed.slice(0, MAX_DESCRIPTION_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : cut.length)}…`;
}

/**
 * @param {string} html
 * @returns {{markdown: string, firstParagraph: string}}
 */
export function htmlToMarkdown(html) {
  const htmlTree = fromHtml(html, { fragment: true });
  dropUnusableImages(htmlTree);
  const markdownTree = toMdast(htmlTree);
  dropBlankParagraphs(markdownTree);
  const blocks = 'children' in markdownTree ? markdownTree.children : [];
  const firstParagraph = blocks.find((block) => block.type === 'paragraph');
  return {
    markdown: toMarkdown(markdownTree, {
      extensions: [gfmToMarkdown()],
      bullet: '-',
      emphasis: '_',
      rule: '-',
    }).trim(),
    firstParagraph: firstParagraph ? textOf(firstParagraph) : '',
  };
}

/**
 * A text-only email is published as written, so Markdown typed by hand works.
 *
 * @param {string} text
 */
function textToMarkdown(text) {
  const markdown = text.replace(/\r\n?/gu, '\n').trim();
  return { markdown, firstParagraph: markdown.split(/\n\s*\n/u)[0] };
}

/**
 * @param {{subject?: string, html?: string, text?: string}} email A parsed message.
 * @param {Date} now
 * @returns {{slug: string, path: string, title: string, content: string}}
 */
export function buildArticle(email, now) {
  const title = String(email.subject ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!title) throw new ArticleError('missing_title');

  const html = String(email.html ?? '');
  const { markdown, firstParagraph } = html.trim()
    ? htmlToMarkdown(html)
    : textToMarkdown(String(email.text ?? ''));
  if (!markdown) throw new ArticleError('empty_body');

  const slug = slugify(title, now);
  // JSON strings are valid YAML, which keeps quotes and colons in a subject
  // from breaking the front matter.
  const frontMatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(describe(firstParagraph) || title)}`,
    `pubDate: ${now.toISOString().replace(/\.\d{3}Z$/u, 'Z')}`,
    'tags: []',
    'draft: false',
    '---',
  ].join('\n');

  return {
    slug,
    path: `${CONTENT_DIRECTORY}/${slug}.md`,
    title,
    content: `${frontMatter}\n\n${markdown}\n`,
  };
}
