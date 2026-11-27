import { describe, expect, it } from 'vitest';
import { sanitizeDocumentBlocks, sanitizeInlineHtml } from '../src/inlineHtml.js';

describe('sanitizeInlineHtml', () => {
  it('leaves the markup the editor saves unchanged', () => {
    const html =
      'Hello <b>bold</b> <strong>strong</strong> <i>it</i> <em>em</em> <u>u</u> <s>s</s> ' +
      '<del>del</del> <code>x &lt; y</code>&nbsp;<a href="https://example.com/?a=1&amp;b=2">link</a>' +
      '<br><a href="mailto:me@example.com">mail</a> <a href="http://example.com">old</a> &amp; &#169; "q"';
    expect(sanitizeInlineHtml(html)).toBe(html);
  });

  it('drops scripts, styles and other script-like elements with their content', () => {
    expect(sanitizeInlineHtml('a<script>alert(1)</script>b')).toBe('ab');
    expect(sanitizeInlineHtml('a<SCRIPT type="x">alert(1)</ScRiPt >b')).toBe('ab');
    expect(sanitizeInlineHtml('a<style>*{display:none}</style>b')).toBe('ab');
    expect(sanitizeInlineHtml('a<iframe src="https://x"></iframe>b')).toBe('ab');
    expect(sanitizeInlineHtml('a<svg><script>x</script><text>t</text></svg>b')).toBe('ab');
    expect(sanitizeInlineHtml('a<script>never closed')).toBe('a');
  });

  it('drops unknown tags but keeps their text', () => {
    expect(sanitizeInlineHtml('<span style="position:fixed;inset:0">Head</span>')).toBe('Head');
    expect(sanitizeInlineHtml('<div><p>One</p></div>')).toBe('One');
    expect(sanitizeInlineHtml('<mark class="cdx-marker">hi</mark>')).toBe('hi');
  });

  it('removes images and every attribute except a safe href', () => {
    expect(sanitizeInlineHtml('x<img src="https://tracker.example/p.gif">y')).toBe('xy');
    expect(sanitizeInlineHtml('<img src=x onerror=alert(1)>')).toBe('');
    expect(sanitizeInlineHtml('<b onclick="x()" style="color:red" class="c">b</b>')).toBe(
      '<b>b</b>',
    );
    expect(
      sanitizeInlineHtml('<a href="https://e.com" target="_blank" onclick="x()" style="a">l</a>'),
    ).toBe('<a href="https://e.com">l</a>');
    expect(sanitizeInlineHtml('<code class="inline-code">c</code>')).toBe('<code>c</code>');
  });

  it('keeps only http, https and mailto links', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' \tjavascript:alert(1)',
      'java\nscript:alert(1)',
      'jav&#x61;script:alert(1)',
      'jav&#97;script:alert(1)',
      'jav&#x61script:alert(1)',
      'javascript&colon;alert(1)',
      'java&Tab;script:alert(1)',
      'data:text/html,<script>x</script>',
      'vbscript:x',
      'tel:123',
      '/relative',
      '#anchor',
      '&unknown;https://e.com',
    ]) {
      expect(sanitizeInlineHtml(`<a href="${href.replaceAll('"', '&quot;')}">x</a>`), href).toBe(
        '<a>x</a>',
      );
    }
    expect(sanitizeInlineHtml("<a href='https://e.com'>x</a>")).toBe(
      '<a href="https://e.com">x</a>',
    );
    expect(sanitizeInlineHtml('<a href=https://e.com>x</a>')).toBe('<a href="https://e.com">x</a>');
    expect(sanitizeInlineHtml('<a href="  HTTPS://e.com ">x</a>')).toBe(
      '<a href="HTTPS://e.com">x</a>',
    );
    expect(sanitizeInlineHtml('<a href="https&#58;//e.com">x</a>')).toBe(
      '<a href="https://e.com">x</a>',
    );
  });

  it('reads attribute values containing > or quotes as values, not as markup', () => {
    expect(sanitizeInlineHtml('<b title="a>b" onclick="x()">t</b>')).toBe('<b>t</b>');
    expect(
      sanitizeInlineHtml('<a title=\'x" href="javascript:y()\' href="https://e.com">t</a>'),
    ).toBe('<a href="https://e.com">t</a>');
    expect(sanitizeInlineHtml('<a href="https://e.com/?q=<script>">t</a>')).toBe(
      '<a href="https://e.com/?q=&lt;script&gt;">t</a>',
    );
  });

  it('handles malformed markup safely', () => {
    expect(sanitizeInlineHtml('1 < 2 > 0 & more')).toBe('1 &lt; 2 &gt; 0 &amp; more');
    expect(sanitizeInlineHtml('a <b')).toBe('a ');
    expect(sanitizeInlineHtml('a <img src="x onerror=alert(1)>b')).toBe('a ');
    expect(sanitizeInlineHtml('<b><i>open')).toBe('<b><i>open</i></b>');
    expect(sanitizeInlineHtml('stray</b> close')).toBe('stray close');
    expect(sanitizeInlineHtml('<b><i>x</b>y</i>')).toBe('<b><i>x</i></b>y');
    expect(sanitizeInlineHtml('a<!-- <img src=x> -->b<!---->c<!-->d')).toBe('abcd');
    expect(sanitizeInlineHtml('a<!-- never closed <b>x</b>')).toBe('a');
    expect(sanitizeInlineHtml('a<!doctype html>b<?xml x?>c</ x>d</')).toBe('abcd&lt;/');
    expect(sanitizeInlineHtml('<BR/><B>x</B>')).toBe('<br><b>x</b>');
    expect(sanitizeInlineHtml('<<b>>x')).toBe('&lt;<b>&gt;x</b>');
  });

  it('is idempotent', () => {
    for (const html of [
      '<a href="https://e.com/?a=1&b=2&amp;c">x</a> & y > z <b>open',
      '<a href="jav&#x61;script:x">x</a><script>y</script>&nbsp<i>i</i>',
      '1 < 2 <!-- c --> <span>s</span> &#169; &amp;amp;',
    ]) {
      const once = sanitizeInlineHtml(html);
      expect(sanitizeInlineHtml(once)).toBe(once);
    }
  });

  it('runs in linear time on adversarial input', () => {
    const inputs = [
      '<'.repeat(200_000),
      '<a '.repeat(100_000),
      '&a'.repeat(100_000),
      `<a href="${' '.repeat(200_000)}x">`,
      '</'.repeat(100_000),
      '<script>' + '</scrip'.repeat(30_000),
    ];
    const started = performance.now();
    for (const input of inputs) sanitizeInlineHtml(input);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('sanitizeDocumentBlocks', () => {
  /** @param {string} type @param {any} data */
  const block = (type, data) => ({ id: type, type, data });

  it('sanitises paragraph, header, list (at every depth) and image caption HTML', () => {
    const [paragraph, header, nested, legacy, image] = sanitizeDocumentBlocks([
      block('paragraph', { text: '<b>Bold</b><img src="x" onerror="alert(1)">' }),
      block('header', { text: '<span>Head</span>', level: 2 }),
      block('list', {
        style: 'checklist',
        items: [
          {
            content: '<i>One</i><img src="https://tracker.example/p.gif">',
            meta: { checked: true },
            items: [{ content: '<u onmouseover="x()">Two</u>', meta: {}, items: [] }],
          },
          { text: '<em>Old object</em><iframe></iframe>' },
        ],
      }),
      block('list', { style: 'unordered', items: ['<em>Old</em><iframe src="x"></iframe>'] }),
      block('image', {
        file: { url: 'https://e.com/a.png' },
        caption: '<a href="javascript:x">c</a>',
      }),
    ]);

    expect(paragraph.data.text).toBe('<b>Bold</b>');
    expect(header.data).toEqual({ text: 'Head', level: 2 });
    expect(nested.data.items).toEqual([
      {
        content: '<i>One</i>',
        meta: { checked: true },
        items: [{ content: '<u>Two</u>', meta: {}, items: [] }],
      },
      { text: '<em>Old object</em>' },
    ]);
    expect(legacy.data.items).toEqual(['<em>Old</em>']);
    expect(image.data).toEqual({ file: { url: 'https://e.com/a.png' }, caption: '<a>c</a>' });
  });

  it('passes other block types and non-string fields through untouched', () => {
    const code = block('code', { code: '<script>kept as code</script>', language: 'html' });
    const empty = { type: 'paragraph' };
    const result = sanitizeDocumentBlocks([
      code,
      empty,
      block('paragraph', { text: 42 }),
      block('list', { items: [7, null, ['x']] }),
    ]);

    expect(result[0]).toBe(code);
    expect(result[1]).toBe(empty);
    expect(result[2].data.text).toBe(42);
    expect(result[3].data.items).toEqual([7, null, ['x']]);
  });

  it('does not change the blocks it is given', () => {
    const blocks = [block('paragraph', { text: '<a href="javascript:x()">x</a>' })];
    sanitizeDocumentBlocks(blocks);
    expect(blocks[0].data.text).toBe('<a href="javascript:x()">x</a>');
  });
});
