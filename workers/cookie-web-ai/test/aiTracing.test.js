import { afterEach, describe, expect, test, vi } from 'vitest';

const span = { setAttribute: vi.fn(), setStatus: vi.fn() };
const startSpan = vi.fn((_options, callback) => callback(span));
vi.mock('@sentry/cloudflare', () => ({
  startSpan: (options, callback) => startSpan(options, callback),
}));
const { requestAiJson, sanitizeAiSpan } = await import('../src/aiTracing.js');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('model tracing', () => {
  test('returns the original payload and records token totals without content', async () => {
    const payload = {
      model: 'gpt-5.6-sol',
      output_text: 'private output',
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 50 },
        output_tokens_details: { reasoning_tokens: 20 },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(requestAiJson('gpt-5.6-sol', { body: 'private prompt' })).resolves.toEqual(
      payload,
    );
    expect(span.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 100);
    expect(span.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 40);
    expect(span.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 50);
    expect(span.setAttribute).toHaveBeenCalledWith('gen_ai.usage.reasoning.output_tokens', 20);
    expect(JSON.stringify([startSpan.mock.calls, span.setAttribute.mock.calls])).not.toContain(
      'private',
    );
  });

  test.each(['http', 'network', 'json', 'incomplete'])(
    'records %s failures without diagnostic content',
    async (kind) => {
      const fetchMock = vi.fn();
      if (kind === 'network') fetchMock.mockRejectedValue(new Error('private failure'));
      else if (kind === 'http')
        fetchMock.mockResolvedValue(new Response('private failure', { status: 500 }));
      else if (kind === 'json') fetchMock.mockResolvedValue(new Response('private invalid JSON'));
      else fetchMock.mockResolvedValue(Response.json({ status: 'incomplete' }));
      vi.stubGlobal('fetch', fetchMock);
      if (kind === 'incomplete') await requestAiJson('model', {});
      else await expect(requestAiJson('model', {})).rejects.toThrow();
      expect(span.setStatus).toHaveBeenCalledWith({ code: 2 });
      expect(JSON.stringify(span.setAttribute.mock.calls)).not.toContain('private');
    },
  );

  test('sanitizes unrelated spans and strips content, links, and arbitrary metadata', () => {
    const source = /** @type {any} */ ({
      name: 'chat model',
      trace_id: 'trace',
      span_id: 'span',
      attributes: {
        'sentry.op': 'gen_ai.chat',
        'gen_ai.conversation.id': 'opaque-id',
        'gen_ai.input.messages': 'private',
        'db.statement': 'private',
      },
      links: [{ private: true }],
    });
    const result = sanitizeAiSpan(source);
    expect(result?.attributes['gen_ai.conversation.id']).toBe('opaque-id');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(
      sanitizeAiSpan({ ...source, name: 'private URL', attributes: { 'sentry.op': 'http.client' } })
        .name,
    ).toBe('worker');
  });
});
