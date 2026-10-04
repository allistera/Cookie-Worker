import { describe, expect, test } from 'vitest';
import { blocksToText, textToBlocks } from '../src/blocks.js';

describe('blocks', () => {
  test('heading, paragraph and bullets round trip', () => {
    const text = '# Title\n\nSome words here.\nSecond line.\n\n- one\n- two';
    const blocks = textToBlocks(text);
    expect(blocks.map((b) => b.type)).toEqual(['header', 'paragraph', 'list']);
    expect(blocks[0].data).toEqual({ text: 'Title', level: 1 });
    expect(blocksToText(blocks)).toBe(text);
  });

  test('HTML in input is escaped and unescaped on the way back', () => {
    const blocks = textToBlocks('<script>alert(1)</script> & more');
    expect(blocks[0].data.text).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more');
    expect(blocksToText(blocks)).toBe('<script>alert(1)</script> & more');
  });

  test('nested lists and checklists render', () => {
    const text = blocksToText([
      {
        type: 'list',
        data: { items: [{ content: 'a', items: [{ content: '<b>b</b>', items: [] }] }, 'c'] },
      },
      {
        type: 'checklist',
        data: {
          items: [
            { text: 'done', checked: true },
            { text: 'todo', checked: false },
          ],
        },
      },
    ]);
    expect(text).toBe('- a\n  - b\n- c\n\n[x] done\n[ ] todo');
  });

  test('unknown block types and non-arrays are skipped', () => {
    expect(
      blocksToText([
        { type: 'embed', data: { x: 1 } },
        { type: 'paragraph', data: { text: 'hi' } },
      ]),
    ).toBe('hi');
    expect(blocksToText(/** @type {any} */ (null))).toBe('');
  });
});
