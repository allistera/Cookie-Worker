import { afterEach, describe, expect, test, vi } from 'vitest';
import { analyzeEmail, fetchImportantMessages, ANALYSIS_PROMPT_VERSION } from '../src/analyze.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const MESSAGE = {
  id: 'msg-1',
  from_address: 'accountant@example.com',
  subject: 'VAT deadline',
  body_text: 'Please send the receipts by Friday.',
};

describe('analyzeEmail', () => {
  test('requests a structured analysis and parses it', async () => {
    const analysis = {
      summary: 'Accountant needs receipts by Friday.',
      tasks: [{ content: 'Send receipts', due_date: '2026-07-24' }],
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ output_text: JSON.stringify(analysis) }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(analyzeEmail(MESSAGE, 'key', 'gpt-5.6-luna')).resolves.toEqual(analysis);

    const [url, init] = /** @type {[string, {headers: Record<string, string>, body: string}]} */ (
      /** @type {unknown} */ (fetchMock.mock.calls[0])
    );
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-5.6-luna');
    expect(body.max_output_tokens).toBe(1500);
    expect(body.text.format.type).toBe('json_schema');
    expect(JSON.stringify(body.input)).toContain('VAT deadline');
  });

  test('surfaces incomplete output instead of parsing truncated JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output_text: '{"summary":"tru',
        }),
      })),
    );

    await expect(analyzeEmail(MESSAGE, 'key', 'gpt-5.6-luna')).rejects.toThrow(
      /incomplete \(max_output_tokens\)/,
    );
  });

  test('throws on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' })),
    );
    await expect(analyzeEmail(MESSAGE, 'key', 'gpt-5.6-luna')).rejects.toThrow(
      'OpenAI request failed (429)',
    );
  });

  test('exposes a prompt version for provenance', () => {
    expect(ANALYSIS_PROMPT_VERSION).toMatch(/^email-task-analysis-v/);
  });
});

describe('fetchImportantMessages', () => {
  test('selects recent high-priority inbound mail', async () => {
    const calls = [];
    const sql = (strings, ...values) => {
      calls.push({ text: strings.join('$'), values });
      return Promise.resolve([MESSAGE]);
    };
    const rows = await fetchImportantMessages(/** @type {any} */ (sql), 'user-1');
    expect(rows).toEqual([MESSAGE]);
    expect(calls[0].text).toContain('message_ai');
    expect(calls[0].text).toContain("priority = 'high'");
    expect(calls[0].values).toContain('user-1');
  });
});
