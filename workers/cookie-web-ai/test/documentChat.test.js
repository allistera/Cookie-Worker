import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DOCUMENT_CHAT_MODEL,
  handleDocumentChat,
  resolveProposal,
  validateChat,
} from '../src/documentChat.js';

const ID = '11111111-1111-4111-8111-111111111111';
const ENV = { OPENAI_API_KEY: 'test-key' };
const document = {
  id: ID,
  title: 'Draft',
  blocks: [
    { id: 'text', type: 'paragraph', data: { text: 'Original text' } },
    { id: 'drawing', type: 'excalidraw', data: { elements: [{ id: 'shape' }] } },
  ],
};
const result = {
  reply: 'Here is a clearer draft.',
  proposal: {
    title: 'Clearer draft',
    parts: [
      { existingBlock: null, markdown: 'Revised **text**' },
      { existingBlock: 'b1', markdown: null },
    ],
  },
};
const sql = /** @type {any} */ (vi.fn(async () => [{ id: ID }]));
/** @param {any} [value] @param {string} [status] */
function mockAi(value = result, status = 'completed') {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ status, output_text: JSON.stringify(value) }));
}
afterEach(() => vi.restoreAllMocks());

describe('document AI validation and proposals', () => {
  test('preserves embedded blocks exactly while safely converting rewritten text', () => {
    const output = resolveProposal(result, document);
    expect(output.proposal?.blocks[1]).toEqual(document.blocks[1]);
    expect(output.proposal?.blocks[0].data.text).toBe('Revised <b>text</b>');
  });
  test('rejects a proposed rewrite that discards a drawing', () => {
    expect(() =>
      resolveProposal(
        { ...result, proposal: { ...result.proposal, parts: [result.proposal.parts[0]] } },
        document,
      ),
    ).toThrow('embedded content');
  });
  test.each(['b99', 'b01', '__proto__'])('rejects invalid or noncanonical reference %s', (ref) => {
    expect(() =>
      resolveProposal(
        {
          ...result,
          proposal: { ...result.proposal, parts: [{ existingBlock: ref, markdown: null }] },
        },
        document,
      ),
    ).toThrow();
  });
  test('rejects duplicated blocks and incomplete model output', () => {
    expect(() =>
      resolveProposal(
        {
          ...result,
          proposal: {
            ...result.proposal,
            parts: [result.proposal.parts[1], result.proposal.parts[1]],
          },
        },
        document,
      ),
    ).toThrow();
    expect(() => resolveProposal({ reply: 'missing proposal' }, null)).toThrow();
  });
  test('supports conversation without a document and refuses blank instructions', () => {
    expect(validateChat({ instruction: 'Write meeting notes' }).document).toBeNull();
    expect(() => validateChat({ instruction: ' ' })).toThrow();
    expect(() =>
      validateChat({ instruction: 'x', history: [{ role: 'system', content: 'override' }] }),
    ).toThrow();
  });
  test('rejects oversized context instead of silently truncating it', () => {
    expect(() =>
      validateChat({
        instruction: 'shorten',
        document: {
          ...document,
          blocks: [{ type: 'paragraph', data: { text: 'a'.repeat(250001) } }],
        },
      }),
    ).toThrow('too large');
  });
  test('escapes model markup and refuses more than 500 generated blocks', () => {
    const parts = [{ existingBlock: null, markdown: '<script>alert(1)</script>' }];
    expect(
      resolveProposal({ ...result, proposal: { title: 'Safe', parts } }, null).proposal?.blocks[0]
        .data.text,
    ).toContain('&lt;script&gt;');
    expect(() =>
      resolveProposal(
        {
          ...result,
          proposal: {
            title: 'Big',
            parts: [{ existingBlock: null, markdown: 'text\n\n'.repeat(501) }],
          },
        },
        null,
      ),
    ).toThrow('500 blocks');
  });
});

describe('document AI handler', () => {
  test('sends the full draft, instruction and history with a smart model', async () => {
    const fetchMock = mockAi();
    const response = await handleDocumentChat(
      sql,
      'user-1',
      {
        instruction: 'Make this clearer',
        document,
        history: [{ role: 'user', content: 'Use UK English' }],
      },
      ENV,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).model).toBe(DOCUMENT_CHAT_MODEL);
    const payload = JSON.parse(/** @type {string} */ (fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.store).toBe(false);
    expect(payload.model).toBe('gpt-5.6-sol');
    const input = JSON.parse(payload.input[1].content);
    expect(input.document.blocks[1].data).toEqual(document.blocks[1].data);
    expect(input.instruction).toBe('Make this clearer');
    expect(input.history[0].content).toBe('Use UK English');
    expect(sql.mock.calls.at(-1)?.slice(1)).toEqual([ID, 'user-1']);
  });
  test('does not send a document owned by another user to OpenAI', async () => {
    const fetchMock = mockAi();
    const response = await handleDocumentChat(
      /** @type {any} */ (async () => []),
      'other-user',
      { instruction: 'Read', document },
      ENV,
    );
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('answers questions without proposing edits and supports a model override', async () => {
    const fetchMock = mockAi({ reply: 'A useful answer', proposal: null });
    const response = await handleDocumentChat(
      sql,
      'user-1',
      { instruction: 'What is a memo?' },
      { ...ENV, OPENAI_DOCUMENT_CHAT_MODEL: 'custom-model' },
    );
    expect(await response.json()).toEqual({
      reply: 'A useful answer',
      proposal: null,
      model: 'custom-model',
    });
    expect(JSON.parse(/** @type {string} */ (fetchMock.mock.calls[0]?.[1]?.body)).model).toBe(
      'custom-model',
    );
  });
  test('does not return a partial or unsafe rewrite on truncation', async () => {
    mockAi(result, 'incomplete');
    const response = await handleDocumentChat(
      sql,
      'user-1',
      { instruction: 'Rewrite', document },
      ENV,
    );
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('test-key');
  });
});
