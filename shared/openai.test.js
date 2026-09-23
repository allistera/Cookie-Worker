import { afterEach, describe, expect, test } from 'vitest';
import {
  OPENAI_BASE_URL,
  OpenAIOutputError,
  configureOpenAi,
  openAiUrl,
  parseOutputJson,
  responsesUrl,
} from './openai.js';

describe('configureOpenAi', () => {
  afterEach(() => {
    configureOpenAi({});
  });

  test('calls OpenAI directly until a gateway is configured', () => {
    expect(responsesUrl()).toBe(`${OPENAI_BASE_URL}/responses`);
    expect(openAiUrl('chat/completions')).toBe(`${OPENAI_BASE_URL}/chat/completions`);
  });

  test('routes through the AI Gateway once an account and gateway id are set', () => {
    configureOpenAi({ CLOUDFLARE_ACCOUNT_ID: 'acct123', AI_GATEWAY_ID: 'cookie' });

    expect(responsesUrl()).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct123/cookie/openai/responses',
    );
    expect(openAiUrl('chat/completions')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct123/cookie/openai/chat/completions',
    );
  });

  test('keeps calling OpenAI directly when only one of the two ids is set', () => {
    configureOpenAi({ CLOUDFLARE_ACCOUNT_ID: 'acct123' });
    expect(responsesUrl()).toBe(`${OPENAI_BASE_URL}/responses`);

    configureOpenAi({ AI_GATEWAY_ID: ' ' });
    expect(responsesUrl()).toBe(`${OPENAI_BASE_URL}/responses`);
  });
});

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
