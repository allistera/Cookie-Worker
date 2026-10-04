import { describe, expect, test } from 'vitest';
import { ApiError } from '../src/api.js';
import { htmlToText, toolError, toolResult, ToolInputError, truncateText } from '../src/results.js';

describe('results', () => {
  test('toolResult returns structured content and a JSON text rendering', () => {
    expect(toolResult({ a: 1 })).toEqual({
      structuredContent: { a: 1 },
      content: [{ type: 'text', text: '{"a":1}' }],
    });
  });

  test('truncateText caps at the limit and flags it', () => {
    expect(truncateText('abc', 2)).toEqual({ text: 'ab', truncated: true });
    expect(truncateText('abc', 5)).toEqual({ text: 'abc', truncated: false });
    expect(truncateText(null)).toEqual({ text: '', truncated: false });
  });

  test('htmlToText drops tags, scripts and styles and decodes common entities', () => {
    expect(
      htmlToText('<style>x{}</style><p>Hi&nbsp;<b>there</b> &amp; you</p><script>1</script>'),
    ).toBe('Hi there & you');
  });

  test('htmlToText decodes numeric character references without double-decoding', () => {
    expect(htmlToText('<p>It&#8217;s &#x201C;fine&#x201d; &#39;ok&apos; &#x1F600;</p>')).toBe(
      "It\u2019s \u201Cfine\u201D 'ok' \u{1F600}",
    );
    // An escaped reference is text, not a reference.
    expect(htmlToText('&amp;#39; &amp;lt;b&amp;gt;')).toBe('&#39; &lt;b&gt;');
    // Out-of-range references are dropped rather than throwing.
    expect(htmlToText('a&#9999999;b&#0;c')).toBe('abc');
  });

  test('toolError explains API failures with actionable text', () => {
    expect(toolError(new ApiError('labels', 409, 'A label with that name already exists'))).toEqual(
      {
        isError: true,
        content: [{ type: 'text', text: 'Conflict: A label with that name already exists' }],
      },
    );
    expect(
      toolError(new ApiError('search', 429, 'Too many questions, slow down')).content[0].text,
    ).toBe('Rate limited: Too many questions, slow down. Wait about a minute before retrying.');
    expect(toolError(new ApiError('emails', 403, 'Forbidden')).content[0].text).toBe(
      'This Cookie account is not provisioned for mailbox access.',
    );
    expect(toolError(new ApiError('emails', 502, 'Failed')).content[0].text).toBe(
      'Cookie could not complete the request (status 502). Try again later.',
    );
    expect(toolError(new ToolInputError('Give at least one change')).content[0].text).toBe(
      'Invalid input: Give at least one change',
    );
  });
});
