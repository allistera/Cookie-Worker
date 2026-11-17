import { describe, expect, test } from 'vitest';
import {
  ArticleError,
  buildArticle,
  htmlToMarkdown,
  MAX_DESCRIPTION_LENGTH,
  MAX_SLUG_LENGTH,
  slugify,
} from '../src/article.js';

const NOW = new Date('2026-11-17T15:30:45.123Z');

describe('slugify', () => {
  test.each([
    ['Clean Up Your GitHub Account', 'clean-up-your-github-account'],
    ['  Hello,   World!  ', 'hello-world'],
    ['Café déjà vu: a "review"', 'cafe-deja-vu-a-review'],
    ['../../etc/passwd', 'etc-passwd'],
  ])('turns %j into %j', (title, slug) => {
    expect(slugify(title, NOW)).toBe(slug);
  });

  test('keeps a long title to a readable length without a trailing dash', () => {
    const slug = slugify(`${'word '.repeat(40)}`, NOW);

    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
  });

  test('falls back to the date when the title has nothing to use', () => {
    expect(slugify('日本語のタイトル', NOW)).toBe('post-2026-11-17');
  });
});

describe('htmlToMarkdown', () => {
  test('converts the formatting a rich-text composer produces', () => {
    const html = [
      '<div>Some <b>bold</b> and <i>italic</i> text with a <a href="https://example.com/a_b">link</a>.</div>',
      '<div><br></div>',
      '<h2>Why I built it</h2>',
      '<ul><li>one</li><li>two</li></ul>',
      '<ol><li>first</li><li>second</li></ol>',
      '<blockquote>quoted</blockquote>',
      '<hr>',
      '<div>Line one<br>Line two</div>',
    ].join('');

    expect(htmlToMarkdown(html).markdown).toBe(
      [
        'Some **bold** and _italic_ text with a [link](https://example.com/a_b).',
        '',
        '## Why I built it',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '2. second',
        '',
        '> quoted',
        '',
        '---',
        '',
        'Line one\\',
        'Line two',
      ].join('\n'),
    );
  });

  test('fences preformatted text and leaves its characters alone', () => {
    const { markdown } = htmlToMarkdown('<pre>if (a &lt; 2) {\n  return `x`;\n}</pre>');

    expect(markdown).toBe('```\nif (a < 2) {\n  return `x`;\n}\n```');
  });

  test('escapes text that Markdown would read as formatting or HTML', () => {
    const { markdown } = htmlToMarkdown(
      '<div># not a heading</div><div>use the &lt;Header&gt; component and *stars*</div>',
    );

    expect(markdown).toBe('\\# not a heading\n\nuse the \\<Header> component and \\*stars\\*');
  });

  test('keeps tables', () => {
    const { markdown } = htmlToMarkdown(
      '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>',
    );

    expect(markdown).toBe('| a | b |\n| - | - |\n| 1 | 2 |');
  });

  test('drops blank paragraphs instead of stacking empty lines', () => {
    const { markdown } = htmlToMarkdown(
      '<div>First</div><div><br></div><div><br></div><div>&nbsp;</div><div>Second</div>',
    );

    expect(markdown).toBe('First\n\nSecond');
  });

  test('keeps images the web can load and drops the ones it cannot', () => {
    const { markdown } = htmlToMarkdown(
      [
        '<p>Intro</p>',
        '<p><img src="https://example.com/photo.png" alt="A photo"></p>',
        '<p><img src="cid:part1@example.com" alt="inline"></p>',
        '<p><img src="data:image/png;base64,AAAA" alt="embedded"></p>',
        '<img src="https://receipts.example.com/read-receipts?token=abc" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0" />',
        '<img src="https://tracker.example.com/open.gif" style="display: none">',
      ].join(''),
    );

    expect(markdown).toBe('Intro\n\n![A photo](https://example.com/photo.png)');
  });

  test('ignores scripts, styles and the document wrapper', () => {
    const { markdown } = htmlToMarkdown(
      '<!doctype html><html><head><title>T</title><style>p{color:red}</style></head><body><script>alert(1)</script><p>Body</p></body></html>',
    );

    expect(markdown).toBe('Body');
  });

  test('reports the first paragraph as plain text', () => {
    const { firstParagraph } = htmlToMarkdown(
      '<h2>Heading</h2><p>The <b>first</b> paragraph with <code>code</code>.</p><p>Second.</p>',
    );

    expect(firstParagraph).toBe('The first paragraph with code.');
  });
});

describe('buildArticle', () => {
  test('writes the front matter the blog schema requires', () => {
    const article = buildArticle(
      { subject: '  Notes on "quotes": a\n test ', html: '<p>Hello <b>there</b>.</p><p>More.</p>' },
      NOW,
    );

    expect(article).toEqual({
      slug: 'notes-on-quotes-a-test',
      path: 'src/content/blog/notes-on-quotes-a-test.md',
      title: 'Notes on "quotes": a test',
      content: [
        '---',
        'title: "Notes on \\"quotes\\": a test"',
        'description: "Hello there."',
        'pubDate: 2026-11-17T15:30:45Z',
        'tags: []',
        'draft: false',
        '---',
        '',
        'Hello **there**.',
        '',
        'More.',
        '',
      ].join('\n'),
    });
  });

  test('publishes a text-only email as written', () => {
    const article = buildArticle(
      { subject: 'Plain', text: '## Section\r\n\r\nSome *Markdown* typed by hand.\r\n' },
      NOW,
    );

    expect(article.content).toContain('description: "## Section"');
    expect(article.content.endsWith('---\n\n## Section\n\nSome *Markdown* typed by hand.\n')).toBe(
      true,
    );
  });

  test('prefers the HTML part over the text part', () => {
    const article = buildArticle(
      { subject: 'Both', html: '<p>From <i>HTML</i></p>', text: 'From text' },
      NOW,
    );

    expect(article.content).toContain('From _HTML_');
    expect(article.content).not.toContain('From text');
  });

  test('cuts a long opening paragraph at a word for the description', () => {
    const article = buildArticle(
      { subject: 'Long', html: `<p>${'lorem ipsum '.repeat(40)}</p>` },
      NOW,
    );

    const description = JSON.parse(/^description: (.*)$/mu.exec(article.content)?.[1] ?? '""');
    expect(description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    expect(description.endsWith('ipsum…') || description.endsWith('lorem…')).toBe(true);
  });

  test('describes an article with no paragraph by its title', () => {
    const article = buildArticle({ subject: 'Just a list', html: '<ul><li>one</li></ul>' }, NOW);

    expect(article.content).toContain('description: "Just a list"');
  });

  test.each([
    ['no subject', { html: '<p>Body</p>' }, 'missing_title'],
    ['a blank subject', { subject: '   ', html: '<p>Body</p>' }, 'missing_title'],
    ['no body', { subject: 'Title' }, 'empty_body'],
    [
      'only a tracking pixel',
      { subject: 'Title', html: '<img src="https://t.example.com/p" width="1" height="1">' },
      'empty_body',
    ],
  ])('refuses an email with %s', (_name, email, reason) => {
    let error;
    try {
      buildArticle(email, NOW);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ArticleError);
    expect(/** @type {ArticleError} */ (error).reason).toBe(reason);
  });
});
