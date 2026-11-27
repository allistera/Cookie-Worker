import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  OPENAI_BASE_URL,
  OpenAIOutputError,
  ResponsesApiError,
  configureOpenAi,
  openAiUrl,
  parseOutputJson,
  requestResponses,
  responsesBody,
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
  test('skips absent items and non-text content before finding JSON output', () => {
    expect(
      parseOutputJson({
        output: [
          null,
          {},
          {
            content: [
              null,
              { type: 'refusal' },
              { type: 'output_text', text: 42 },
              { type: 'output_text', text: '{"ok":true}' },
            ],
          },
        ],
      }),
    ).toEqual({ ok: true });
  });

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

describe('responsesBody', () => {
  const input = [{ role: 'user', content: 'hi' }];

  test('builds the cap, reasoning effort, store flag and strict JSON schema format', () => {
    expect(
      responsesBody({
        model: 'gpt-6-luna',
        input,
        maxOutputTokens: 700,
        reasoningEffort: 'none',
        store: false,
        format: { name: 'draft', schema: { type: 'object' } },
      }),
    ).toEqual({
      model: 'gpt-6-luna',
      store: false,
      max_output_tokens: 700,
      reasoning: { effort: 'none' },
      input,
      text: {
        format: { type: 'json_schema', name: 'draft', strict: true, schema: { type: 'object' } },
      },
    });
  });

  test('sends no reasoning option to a model that does not accept one', () => {
    const body = responsesBody({
      model: 'gpt-4o-mini',
      input,
      maxOutputTokens: 100,
      reasoningEffort: 'none',
    });
    expect(body).toEqual({ model: 'gpt-4o-mini', max_output_tokens: 100, input });
  });

  test('keeps the model default when no effort is given', () => {
    expect(responsesBody({ model: 'gpt-6-luna', input, maxOutputTokens: 100 })).not.toHaveProperty(
      'reasoning',
    );
  });
});

describe('requestResponses', () => {
  const options = {
    apiKey: 'test-key',
    model: 'gpt-6-luna',
    input: [],
    maxOutputTokens: 500,
    reasoningEffort: /** @type {const} */ ('none'),
    timeoutMs: 1_000,
  };

  test('posts the body with the key and returns the payload', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: 'completed', output_text: '{}' }));

    await expect(requestResponses({ ...options, fetchImpl })).resolves.toEqual({
      status: 'completed',
      output_text: '{}',
    });

    const [url, init] = /** @type {any} */ (fetchImpl.mock.calls[0]);
    expect(url).toBe(responsesUrl());
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toEqual({
      model: 'gpt-6-luna',
      max_output_tokens: 500,
      reasoning: { effort: 'none' },
      input: [],
    });
  });

  test('throws ResponsesApiError with the status and OpenAI error code', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { code: 'unsupported_country_region_territory', message: 'private' } },
        { status: 403 },
      ),
    );

    const error = await requestResponses({ ...options, fetchImpl }).catch((err) => err);
    expect(error).toBeInstanceOf(ResponsesApiError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('unsupported_country_region_territory');
    expect(error.message).toBe(
      'OpenAI Responses API responded 403 (unsupported_country_region_territory)',
    );
  });

  test('leaves an incomplete payload for parseOutputJson to name', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
    );

    const payload = await requestResponses({ ...options, fetchImpl });
    expect(() => parseOutputJson(payload)).toThrow(
      'OpenAI response incomplete (max_output_tokens)',
    );
  });

  test('aborts a request that outlives its timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url, /** @type {any} */ init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
          }),
      );
      const request = requestResponses({ ...options, fetchImpl: /** @type {any} */ (fetchImpl) });
      const assertion = expect(request).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
