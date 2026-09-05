import { afterEach, describe, expect, test, vi } from 'vitest';
import { handleDocument, inlineHtml, markdownToBlocks } from '../src/document.js';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const ENV = { OPENAI_API_KEY: 'test-key' };
// /document never touches the database, so the sql argument is unused.
const SQL = /** @type {any} */ (null);

/** @param {string} markdown */
function openAiReturning(markdown, title = 'Kitchen plan') {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ output_text: JSON.stringify({ title, markdown }) }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('markdownToBlocks', () => {
  test('maps headings, paragraphs, dividers and code fences to editor blocks', () => {
    const blocks = markdownToBlocks(
      [
        '# Overview',
        'First line',
        'continues here.',
        '',
        '---',
        '#### Deep heading',
        '```',
        'const x = 1;',
        '```',
      ].join('\n'),
    );

    expect(blocks).toEqual([
      { type: 'header', data: { text: 'Overview', level: 1 } },
      { type: 'paragraph', data: { text: 'First line continues here.' } },
      { type: 'delimiter', data: {} },
      { type: 'header', data: { text: 'Deep heading', level: 3 } },
      { type: 'code', data: { code: 'const x = 1;' } },
    ]);
  });

  test('builds list v2 items with nesting and checklist state', () => {
    const blocks = markdownToBlocks(
      [
        '- Parent',
        '  - Child',
        '- Sibling',
        '',
        '1. One',
        '2. Two',
        '',
        '- [x] Done',
        '- [ ] Todo',
      ].join('\n'),
    );

    expect(blocks).toEqual([
      {
        type: 'list',
        data: {
          style: 'unordered',
          meta: {},
          items: [
            {
              content: 'Parent',
              meta: {},
              items: [{ content: 'Child', meta: {}, items: [] }],
            },
            { content: 'Sibling', meta: {}, items: [] },
          ],
        },
      },
      {
        type: 'list',
        data: {
          style: 'ordered',
          meta: {},
          items: [
            { content: 'One', meta: {}, items: [] },
            { content: 'Two', meta: {}, items: [] },
          ],
        },
      },
      {
        type: 'list',
        data: {
          style: 'checklist',
          meta: {},
          items: [
            { content: 'Done', meta: { checked: true }, items: [] },
            { content: 'Todo', meta: { checked: false }, items: [] },
          ],
        },
      },
    ]);
  });

  test('a list directly followed by text starts a new paragraph', () => {
    expect(markdownToBlocks('- Item\nAfter').map((block) => block.type)).toEqual([
      'list',
      'paragraph',
    ]);
  });

  test('returns no blocks for empty or whitespace input', () => {
    expect(markdownToBlocks('')).toEqual([]);
    expect(markdownToBlocks('\n  \n')).toEqual([]);
    expect(markdownToBlocks(/** @type {any} */ (undefined))).toEqual([]);
  });
});

describe('inlineHtml', () => {
  test('escapes markup before applying inline formatting', () => {
    expect(inlineHtml('<script>x</script> **bold** *it* `co` [go](https://a.example/p?q=1)')).toBe(
      '&lt;script&gt;x&lt;/script&gt; <b>bold</b> <i>it</i> <code class="inline-code">co</code> <a href="https://a.example/p?q=1">go</a>',
    );
  });

  test('leaves non-http links as plain text', () => {
    expect(inlineHtml('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
  });
});

describe('handleDocument', () => {
  test('rejects a missing instruction before calling OpenAI', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleDocument(SQL, USER_ID, {}, ENV);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'instruction is required (max 1000 chars)' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns the title and converted blocks', async () => {
    const fetchMock = openAiReturning('## Steps\n- Measure\n- Order');

    const response = await handleDocument(
      SQL,
      USER_ID,
      { instruction: 'Plan a kitchen renovation' },
      ENV,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.document.title).toBe('Kitchen plan');
    expect(body.document.blocks.map((block) => block.type)).toEqual(['header', 'list']);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.text.format.schema.required).toEqual(['title', 'markdown']);
    expect(JSON.parse(payload.input[1].content)).toEqual({
      instruction: 'Plan a kitchen renovation',
    });
  });

  test('answers 502 when the model returns an empty document', async () => {
    openAiReturning('   ');

    const response = await handleDocument(SQL, USER_ID, { instruction: 'x' }, ENV);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'AI document failed' });
  });

  test('answers 502 without leaking details when OpenAI fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const response = await handleDocument(SQL, USER_ID, { instruction: 'x' }, ENV);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'AI document failed' });
  });
});
