// POST /document — turns a one-line instruction into a new Documents page:
// a title plus Editor.js blocks the SPA saves as-is. Editor.js block JSON is
// a poor fit for a strict JSON schema (every block type has its own data
// shape), so the model writes Markdown and markdownToBlocks converts the
// subset the editor's tools cover — headers, paragraphs, lists (bullet,
// numbered, checklist), fenced code and `---` dividers. Anything else
// becomes a paragraph rather than failing the request.

import { RESPONSES_URL, DEFAULT_MODEL, clean, outputText } from './openai.js';

const MAX_TITLE = 200;
const MAX_BLOCKS = 200;
// The editor registers header levels 1–3 only (DocumentEditor.vue).
const MAX_HEADER_LEVEL = 3;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const DIVIDER_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_RE = /^\s*```/;
const CHECKLIST_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const UNORDERED_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;

/** @param {string} text */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Editor.js paragraph/header/list text is HTML: the toolbar writes <b>, <i>,
// <a> and <code class="inline-code">. Everything is escaped first so model
// output can never inject markup of its own.
/** @param {string} text */
export function inlineHtml(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * @param {string} line
 * @returns {{ indent: number, style: 'unordered' | 'ordered' | 'checklist', text: string, checked?: boolean } | null}
 */
function listLine(line) {
  const checklist = CHECKLIST_RE.exec(line);
  if (checklist) {
    return {
      indent: checklist[1].length,
      style: 'checklist',
      text: checklist[3],
      checked: checklist[2] !== ' ',
    };
  }
  const unordered = UNORDERED_RE.exec(line);
  if (unordered) return { indent: unordered[1].length, style: 'unordered', text: unordered[2] };
  const ordered = ORDERED_RE.exec(line);
  if (ordered) return { indent: ordered[1].length, style: 'ordered', text: ordered[2] };
  return null;
}

/**
 * @param {'unordered' | 'ordered' | 'checklist'} style
 * @param {string} text
 * @param {boolean} [checked]
 */
function listItem(style, text, checked) {
  return {
    content: inlineHtml(text.trim()),
    meta: style === 'checklist' ? { checked: Boolean(checked) } : {},
    items: [],
  };
}

/**
 * Converts the Markdown subset described above into Editor.js blocks
 * (@editorjs/header, @editorjs/list v2, @editorjs/code, @editorjs/delimiter,
 * paragraph). Pure and exported for tests.
 *
 * @param {string} markdown
 * @returns {any[]}
 */
export function markdownToBlocks(markdown) {
  /** @type {any[]} */
  const blocks = [];
  /** @type {string[]} */
  let paragraph = [];
  /** @type {{ style: string, items: any[], stack: { indent: number, items: any[] }[] } | null} */
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', data: { text: inlineHtml(paragraph.join(' ')) } });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: 'list', data: { style: list.style, meta: {}, items: list.items } });
      list = null;
    }
  };

  const lines = String(markdown ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      flushParagraph();
      flushList();
      /** @type {string[]} */
      const code = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', data: { code: code.join('\n') } });
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    if (DIVIDER_RE.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'delimiter', data: {} });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: 'header',
        data: {
          text: inlineHtml(heading[2].replace(/\s+#+\s*$/, '').trim()),
          level: Math.min(heading[1].length, MAX_HEADER_LEVEL),
        },
      });
      continue;
    }

    const item = listLine(line);
    if (item) {
      flushParagraph();
      if (list && list.style !== item.style && item.indent === 0) flushList();
      if (!list) list = { style: item.style, items: [], stack: [] };
      // Nesting follows indentation: deeper lines attach to the last item of
      // the nearest shallower level, shallower lines pop back out.
      while (list.stack.length && list.stack[list.stack.length - 1].indent >= item.indent) {
        list.stack.pop();
      }
      const parent = list.stack.length ? list.stack[list.stack.length - 1].items : list.items;
      const entry = listItem(/** @type {any} */ (list.style), item.text, item.checked);
      parent.push(entry);
      list.stack.push({ indent: item.indent, items: entry.items });
      continue;
    }

    flushList();
    paragraph.push(line.replace(/^\s*>\s?/, '').trim());
  }
  flushParagraph();
  flushList();
  return blocks.slice(0, MAX_BLOCKS);
}

/**
 * @param {string} instruction
 * @param {string} apiKey
 * @param {string} model
 */
export async function generateDocument(instruction, apiKey, model) {
  const response = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model,
      max_output_tokens: 3000,
      input: [
        {
          role: 'system',
          content:
            "You write documents for one private user's notes app. Follow the user instruction and produce a complete, well-structured document. " +
            'Write the body as Markdown using only: headings (#, ##, ###), paragraphs, bullet lists (-), numbered lists (1.), checklists (- [ ]), fenced code blocks (```) and --- dividers. ' +
            'No HTML, no tables, no front matter, and do not repeat the title as a heading. Return only the requested JSON.',
        },
        { role: 'user', content: JSON.stringify({ instruction }) },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'document',
          strict: true,
          schema: {
            type: 'object',
            properties: { title: { type: 'string' }, markdown: { type: 'string' } },
            required: ['title', 'markdown'],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI Responses API responded ${response.status}`);
  const parsed = JSON.parse(outputText(await response.json()));
  const title = clean(parsed?.title, MAX_TITLE);
  const blocks = markdownToBlocks(parsed?.markdown);
  if (!title || !blocks.length) {
    throw new Error('OpenAI Responses API returned an invalid document');
  }
  return { title, blocks };
}

/**
 * POST /document — returns a title and Editor.js blocks for the SPA to save
 * as a new document. Nothing is written server-side; the tasks Worker owns
 * the documents table.
 *
 * @param {import('postgres').Sql} _sql
 * @param {string} _userId
 * @param {any} body
 * @param {{OPENAI_API_KEY: string, OPENAI_DOCUMENT_MODEL?: string}} env
 */
export async function handleDocument(_sql, _userId, body, env) {
  const model = env.OPENAI_DOCUMENT_MODEL || DEFAULT_MODEL;
  const instruction = clean(body.instruction, 1000);
  if (!instruction) {
    return Response.json({ error: 'instruction is required (max 1000 chars)' }, { status: 400 });
  }

  try {
    const document = await generateDocument(instruction, env.OPENAI_API_KEY, model);
    return Response.json({ document, model });
  } catch (err) {
    console.error('POST /document failed:', err);
    return Response.json({ error: 'AI document failed' }, { status: 502 });
  }
}
