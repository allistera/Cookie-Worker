import { describe, expect, test } from 'vitest';
import { OpenAIOutputError, parseOutputJson } from './openai.js';

describe('parseOutputJson', () => {
  test('parses top-level output_text', () => {
    expect(parseOutputJson({ output_text: '{"ok":true}' })).toEqual({ ok: true });
  });

  test('parses output item content text', () => {
    expect(
      parseOutputJson({
        output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      }),
    ).toEqual({ ok: true });
  });

  test('throws a descriptive error for incomplete output', () => {
    const parse = () =>
      parseOutputJson({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      });

    expect(parse).toThrow(OpenAIOutputError);
    expect(parse).toThrow('OpenAI response incomplete (max_output_tokens)');
  });

  test('throws a descriptive error when there is no output text', () => {
    expect(() => parseOutputJson({})).toThrow(OpenAIOutputError);
  });

  test('wraps invalid JSON as a retryable output error', () => {
    expect(() => parseOutputJson({ output_text: '{"ok":' })).toThrow(OpenAIOutputError);
    expect(() => parseOutputJson({ output_text: '{"ok":' })).toThrow(
      'OpenAI response contained invalid JSON',
    );
  });
});
