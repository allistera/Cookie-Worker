import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { attemptAiUnsubscribe } from '../src/aiUnsubscribe.js';
import { configureOpenAi } from '../../../shared/openai.js';

const target = {
  url: 'https://news.example.com/unsubscribe',
  recipientEmail: 'reader@example.com',
};

beforeEach(() => {
  configureOpenAi(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * @param {(url: URL, init: RequestInit) => Response | Promise<Response>} page
 * @param {(body: any) => Response | Promise<Response>} model
 */
function transport(page, model) {
  const fetchMock = vi.fn(
    /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
    async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === '/dns-query') {
        return Response.json({
          Status: 0,
          Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [],
        });
      }
      if (url.hostname === 'api.openai.com') return model(JSON.parse(String(init.body)));
      return page(url, init);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const complete = () =>
  Response.json({ output_text: JSON.stringify({ outcome: 'already_unsubscribed' }) });

describe('AI unsubscribe transport', () => {
  test('submits a validated form and follows its redirect as a body-free GET', async () => {
    const page = vi.fn((url, init) => {
      if (url.pathname === '/unsubscribe')
        return new Response('<form action="/confirm">Confirm</form>');
      if (url.pathname === '/confirm') {
        expect(init.method).toBe('POST');
        expect(init.body).toBe('confirm=yes');
        return new Response(null, { status: 303, headers: { Location: '/done' } });
      }
      expect(url.pathname).toBe('/done');
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      return new Response('Unsubscribed');
    });
    const model = vi.fn((body) =>
      Response.json({
        output: [
          null,
          {},
          {
            content: [
              null,
              { type: 'refusal' },
              {
                type: 'output_text',
                text: JSON.stringify(
                  body.text.format.name === 'unsubscribe_plan'
                    ? {
                        outcome: 'submit_form',
                        form: {
                          action: '/confirm',
                          method: 'POST',
                          fields: [{ name: 'confirm', value: 'yes' }],
                        },
                      }
                    : { confirmed: true },
                ),
              },
            ],
          },
        ],
      }),
    );
    const fetchMock = transport(page, model);
    await expect(
      attemptAiUnsubscribe(target, { apiKey: 'test-key', model: 'test-model' }),
    ).resolves.toEqual({ ok: true });
    expect(page).toHaveBeenCalledTimes(3);
    expect(model).toHaveBeenCalledTimes(2);
    expect(model.mock.calls[0][0]).toMatchObject({
      model: 'test-model',
      text: { format: { strict: true, name: 'unsubscribe_plan' } },
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/dns-query'))).toHaveLength(
      6,
    );
  });

  test('uses the default model for a page that already confirms unsubscribe', async () => {
    const model = vi.fn(complete);
    transport(() => new Response('Already unsubscribed'), model);
    await expect(attemptAiUnsubscribe(target, {})).resolves.toEqual({ ok: true });
    expect(model).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.6-luna' }));
  });

  test('handles a redirect without a Location header as an empty page', async () => {
    const model = vi.fn(complete);
    transport(() => new Response(null, { status: 302 }), model);
    await expect(attemptAiUnsubscribe(target, {})).resolves.toEqual({ ok: true });
    expect(model).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('"page_html":""'),
          }),
        ]),
      }),
    );
  });

  test('stops redirect loops before contacting the model', async () => {
    const page = vi.fn(
      () => new Response(null, { status: 302, headers: { Location: '/unsubscribe' } }),
    );
    const model = vi.fn(complete);
    transport(page, model);
    await expect(attemptAiUnsubscribe(target, {})).resolves.toEqual({ ok: false, reason: 'error' });
    expect(page).toHaveBeenCalledTimes(4);
    expect(model).not.toHaveBeenCalled();
  });

  test('rejects redirects to unsafe URLs before fetching them', async () => {
    const page = vi.fn(
      () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }),
    );
    const model = vi.fn(complete);
    transport(page, model);
    await expect(attemptAiUnsubscribe(target, {})).resolves.toEqual({ ok: false, reason: 'error' });
    expect(page).toHaveBeenCalledOnce();
    expect(model).not.toHaveBeenCalled();
  });

  test('does not start a page fetch after the overall deadline', async () => {
    const page = vi.fn(() => new Response('Page'));
    const model = vi.fn(complete);
    transport(page, model);
    await expect(attemptAiUnsubscribe(target, { timeoutMs: 0 })).resolves.toEqual({
      ok: false,
      reason: 'error',
    });
    expect(page).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  test.each([
    () => new Response('Unavailable', { status: 503 }),
    () => Response.json({ output_text: 'not JSON' }),
    () => Response.json({}),
  ])('fails closed on model transport or output errors', async (model) => {
    transport(() => new Response('Page'), model);
    await expect(attemptAiUnsubscribe(target, {})).resolves.toEqual({ ok: false, reason: 'error' });
  });

  test('bounds streamed page content even when cancellation fails', async () => {
    const cancel = vi.fn(() => {
      throw new Error('disconnected');
    });
    transport(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(512 * 1024).fill(65));
            },
            cancel,
          }),
        ),
      complete,
    );
    await expect(attemptAiUnsubscribe(target, {})).resolves.toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
