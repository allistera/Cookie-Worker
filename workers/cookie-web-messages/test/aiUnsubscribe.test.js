import { describe, expect, test, vi } from 'vitest';
import { attemptAiUnsubscribe, sanitizePageHtml, validateFormPlan } from '../src/aiUnsubscribe.js';

const PAGE_URL = 'https://news.example.com/unsubscribe?u=42';
const EMAIL = 'user@cookie.example';

describe('sanitizePageHtml', () => {
  test('strips scripts, styles, svg, and comments but keeps forms', () => {
    const html =
      '<script>evil()</script><style>.x{}</style><svg><path/></svg><!-- note -->' +
      '<form action="/u"><input type="hidden" name="t" value="abc"></form>';
    const out = sanitizePageHtml(html, 10_000);
    expect(out).not.toContain('evil()');
    expect(out).not.toContain('.x{}');
    expect(out).not.toContain('note');
    expect(out).toContain('<form action="/u">');
  });

  test('caps the output length and tolerates non-strings', () => {
    expect(sanitizePageHtml('a'.repeat(100), 10)).toHaveLength(10);
    expect(sanitizePageHtml(null, 10)).toBe('');
  });
});

describe('validateFormPlan', () => {
  const html =
    '<form><input name="token" value="deadbeefcafe-long-hidden-token-value-12345"></form>';

  test('accepts a same-host POST and resolves a relative action', () => {
    const plan = {
      action: '/unsub/confirm',
      method: 'POST',
      fields: [{ name: 'email', value: EMAIL }],
    };
    expect(validateFormPlan(plan, PAGE_URL, html, EMAIL)).toEqual({
      action: 'https://news.example.com/unsub/confirm',
      method: 'POST',
      fields: [{ name: 'email', value: EMAIL }],
    });
  });

  test('accepts an action on a sibling host of the page domain', () => {
    const plan = { action: 'https://example.com/u', method: 'GET', fields: [] };
    expect(validateFormPlan(plan, PAGE_URL, html, EMAIL)).not.toBeNull();
  });

  test('rejects an action on an unrelated host', () => {
    const plan = { action: 'https://attacker.example.net/u', method: 'POST', fields: [] };
    expect(validateFormPlan(plan, PAGE_URL, html, EMAIL)).toBeNull();
  });

  test('rejects a non-HTTPS or otherwise unsafe action', () => {
    expect(
      validateFormPlan(
        { action: 'http://news.example.com/u', method: 'POST', fields: [] },
        PAGE_URL,
        html,
        EMAIL,
      ),
    ).toBeNull();
    expect(
      validateFormPlan(
        { action: 'https://10.0.0.1/u', method: 'POST', fields: [] },
        PAGE_URL,
        html,
        EMAIL,
      ),
    ).toBeNull();
  });

  test('rejects header-injection characters in names and values', () => {
    const plan = {
      action: '/u',
      method: 'POST',
      fields: [{ name: 'x\r\nInjected', value: 'y' }],
    };
    expect(validateFormPlan(plan, PAGE_URL, html, EMAIL)).toBeNull();
  });

  test('allows a long hidden value only when it appears in the page HTML', () => {
    const present = {
      action: '/u',
      method: 'POST',
      fields: [{ name: 'token', value: 'deadbeefcafe-long-hidden-token-value-12345' }],
    };
    expect(validateFormPlan(present, PAGE_URL, html, EMAIL)).not.toBeNull();

    const fabricated = {
      action: '/u',
      method: 'POST',
      fields: [{ name: 'token', value: 'a-long-value-the-model-made-up-out-of-thin-air' }],
    };
    expect(validateFormPlan(fabricated, PAGE_URL, html, EMAIL)).toBeNull();
  });

  test('rejects malformed shapes', () => {
    expect(validateFormPlan(null, PAGE_URL, html, EMAIL)).toBeNull();
    expect(
      validateFormPlan({ action: '/u', method: 'PUT', fields: [] }, PAGE_URL, html, EMAIL),
    ).toBeNull();
    expect(
      validateFormPlan({ action: '/u', method: 'POST', fields: 'nope' }, PAGE_URL, html, EMAIL),
    ).toBeNull();
    expect(
      validateFormPlan(
        {
          action: '/u',
          method: 'POST',
          fields: Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, value: '' })),
        },
        PAGE_URL,
        html,
        EMAIL,
      ),
    ).toBeNull();
  });
});

describe('attemptAiUnsubscribe', () => {
  const target = { url: PAGE_URL, recipientEmail: EMAIL };

  test('succeeds without a submit when the page already confirms', async () => {
    const fetchText = vi.fn().mockResolvedValue({
      status: 200,
      url: PAGE_URL,
      text: '<p>You have been unsubscribed.</p>',
    });
    const requestModel = vi.fn().mockResolvedValue({ outcome: 'already_unsubscribed', form: null });

    const result = await attemptAiUnsubscribe(target, { fetchText, requestModel });

    expect(result.ok).toBe(true);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(requestModel).toHaveBeenCalledTimes(1);
  });

  test('submits the validated form as POST and confirms via the model', async () => {
    const fetchText = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        url: PAGE_URL,
        text: '<form action="/confirm"><input type="hidden" name="u" value="42"></form>',
      })
      .mockResolvedValueOnce({
        status: 200,
        url: PAGE_URL,
        text: '<p>Done, you are off the list.</p>',
      });
    const requestModel = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'submit_form',
        form: {
          action: '/confirm',
          method: 'POST',
          fields: [
            { name: 'u', value: '42' },
            { name: 'email', value: EMAIL },
          ],
        },
      })
      .mockResolvedValueOnce({ confirmed: true });

    const result = await attemptAiUnsubscribe(target, { fetchText, requestModel });

    expect(result.ok).toBe(true);
    expect(fetchText).toHaveBeenCalledTimes(2);
    const [submitUrl, submitOptions] = fetchText.mock.calls[1];
    expect(submitUrl).toBe('https://news.example.com/confirm');
    expect(submitOptions.method).toBe('POST');
    expect(submitOptions.body).toBe(`u=42&email=${encodeURIComponent(EMAIL)}`);
    expect(requestModel).toHaveBeenCalledTimes(2);
  });

  test('appends fields as query parameters for a GET form', async () => {
    const fetchText = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        url: PAGE_URL,
        text: '<a href="/confirm?u=42">Yes</a>',
      })
      .mockResolvedValueOnce({ status: 200, url: PAGE_URL, text: 'Unsubscribed' });
    const requestModel = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'submit_form',
        form: { action: '/confirm?u=42', method: 'GET', fields: [{ name: 'all', value: 'yes' }] },
      })
      .mockResolvedValueOnce({ confirmed: true });

    const result = await attemptAiUnsubscribe(target, { fetchText, requestModel });

    expect(result.ok).toBe(true);
    expect(fetchText.mock.calls[1][0]).toBe('https://news.example.com/confirm?u=42&all=yes');
  });

  test('fails without a model call when the page itself errors', async () => {
    const fetchText = vi.fn().mockResolvedValue({ status: 404, url: PAGE_URL, text: 'gone' });
    const requestModel = vi.fn();

    const result = await attemptAiUnsubscribe(target, { fetchText, requestModel });

    expect(result).toEqual({ ok: false, reason: 'page_status_404' });
    expect(requestModel).not.toHaveBeenCalled();
  });

  test('fails when the model deems the page unsupported', async () => {
    const fetchText = vi
      .fn()
      .mockResolvedValue({ status: 200, url: PAGE_URL, text: '<p>Log in</p>' });
    const requestModel = vi.fn().mockResolvedValue({ outcome: 'unsupported', form: null });

    const result = await attemptAiUnsubscribe(target, { fetchText, requestModel });

    expect(result).toEqual({ ok: false, reason: 'unsupported_page' });
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  test('fails closed, with no submit request, when the plan targets another host', async () => {
    const fetchText = vi
      .fn()
      .mockResolvedValue({ status: 200, url: PAGE_URL, text: '<form></form>' });
    const requestModel = vi.fn().mockResolvedValue({
      outcome: 'submit_form',
      form: { action: 'https://attacker.example.net/steal', method: 'POST', fields: [] },
    });

    const result = await attemptAiUnsubscribe(target, { fetchText, requestModel });

    expect(result).toEqual({ ok: false, reason: 'invalid_form_plan' });
    expect(fetchText).toHaveBeenCalledTimes(1);
  });

  test('fails without a verify call when the submit response errors', async () => {
    const fetchText = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, url: PAGE_URL, text: '<form action="/c"></form>' })
      .mockResolvedValueOnce({ status: 500, url: PAGE_URL, text: 'oops' });
    const requestModel = vi.fn().mockResolvedValueOnce({
      outcome: 'submit_form',
      form: { action: '/c', method: 'POST', fields: [] },
    });

    const result = await attemptAiUnsubscribe(target, { fetchText, requestModel });

    expect(result).toEqual({ ok: false, reason: 'submit_status_500' });
    expect(requestModel).toHaveBeenCalledTimes(1);
  });

  test('fails when the model cannot confirm the outcome', async () => {
    const fetchText = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, url: PAGE_URL, text: '<form action="/c"></form>' })
      .mockResolvedValueOnce({ status: 200, url: PAGE_URL, text: 'Are you sure?' });
    const requestModel = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'submit_form',
        form: { action: '/c', method: 'POST', fields: [] },
      })
      .mockResolvedValueOnce({ confirmed: false });

    const result = await attemptAiUnsubscribe(target, { fetchText, requestModel });

    expect(result).toEqual({ ok: false, reason: 'unconfirmed' });
  });

  test('never throws — a failing dependency becomes { ok: false }', async () => {
    const fetchText = vi.fn().mockRejectedValue(new Error('DNS resolution failed'));
    const result = await attemptAiUnsubscribe(target, { fetchText, requestModel: vi.fn() });
    expect(result).toEqual({ ok: false, reason: 'error' });
  });
});
