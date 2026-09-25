import { describe, expect, test } from 'vitest';
import {
  isSafeUnsubscribeUrl,
  MAX_MAILTO_SUBJECT_LENGTH,
  parseListUnsubscribe,
} from '../src/unsubscribe.js';

const h = (key, value) => ({ key, value });

/**
 * parseListUnsubscribe returns T | null; these tests assert a specific
 * parsed shape, so narrow the null case here once instead of at every call.
 *
 * @param {ReturnType<typeof parseListUnsubscribe>} value
 */
function assertParsed(value) {
  if (!value) throw new Error('expected parseListUnsubscribe to return a non-null result');
  return value;
}

describe('parseListUnsubscribe', () => {
  test('returns null when headers are null or undefined', () => {
    expect(parseListUnsubscribe(null)).toBeNull();
    expect(parseListUnsubscribe(undefined)).toBeNull();
  });

  test('returns null for a non-array (malformed) headers value', () => {
    expect(parseListUnsubscribe('List-Unsubscribe: <x>')).toBeNull();
    expect(parseListUnsubscribe({ key: 'List-Unsubscribe', value: '<x>' })).toBeNull();
    expect(parseListUnsubscribe(42)).toBeNull();
  });

  test('returns null when no List-Unsubscribe header is present', () => {
    expect(parseListUnsubscribe([h('Subject', 'Hi'), h('From', 'a@b.com')])).toBeNull();
  });

  test('returns null when the header has no usable URI', () => {
    expect(parseListUnsubscribe([h('List-Unsubscribe', 'not a uri at all')])).toBeNull();
    expect(parseListUnsubscribe([h('List-Unsubscribe', '<ftp://x.example/u>')])).toBeNull();
    expect(parseListUnsubscribe([h('List-Unsubscribe', '<>')])).toBeNull();
  });

  test('parses a url-only List-Unsubscribe', () => {
    const r = assertParsed(
      parseListUnsubscribe([h('List-Unsubscribe', '<https://x.example/u?t=1>')]),
    );
    expect(r).toEqual({ oneClick: false, url: 'https://x.example/u?t=1', mailto: null });
  });

  test('parses an http url as well as https', () => {
    const r = assertParsed(parseListUnsubscribe([h('List-Unsubscribe', '<http://x.example/u>')]));
    expect(r.url).toBe('http://x.example/u');
  });

  test('parses a mailto-only List-Unsubscribe', () => {
    const r = assertParsed(
      parseListUnsubscribe([h('List-Unsubscribe', '<mailto:unsub@x.example>')]),
    );
    expect(r).toEqual({
      oneClick: false,
      url: null,
      mailto: { address: 'unsub@x.example', subject: null },
    });
  });

  test('extracts the subject query param from a mailto', () => {
    const r = assertParsed(
      parseListUnsubscribe([h('List-Unsubscribe', '<mailto:unsub@x.example?subject=stop>')]),
    );
    expect(r.mailto).toEqual({ address: 'unsub@x.example', subject: 'stop' });
  });

  test('decodes an encoded mailto subject', () => {
    const r = assertParsed(
      parseListUnsubscribe([h('List-Unsubscribe', '<mailto:unsub@x.example?subject=Unsub%20me>')]),
    );
    expect(r.mailto?.subject).toBe('Unsub me');
  });

  test('parses both a url and a mailto from a comma-separated value', () => {
    const r = assertParsed(
      parseListUnsubscribe([
        h('List-Unsubscribe', '<https://x.example/u?t=1>, <mailto:unsub@x.example?subject=stop>'),
      ]),
    );
    expect(r).toEqual({
      oneClick: false,
      url: 'https://x.example/u?t=1',
      mailto: { address: 'unsub@x.example', subject: 'stop' },
    });
  });

  test('takes the first http(s) URI and the first mailto when several are present', () => {
    const r = assertParsed(
      parseListUnsubscribe([
        h(
          'List-Unsubscribe',
          '<https://a.example/1>, <https://b.example/2>, <mailto:one@x.example>, <mailto:two@x.example>',
        ),
      ]),
    );
    expect(r.url).toBe('https://a.example/1');
    expect(r.mailto?.address).toBe('one@x.example');
  });

  test('drops a mailto whose target is an address list', () => {
    expect(
      parseListUnsubscribe([h('List-Unsubscribe', '<mailto:a@x.example,b@y.example>')]),
    ).toBeNull();
    expect(parseListUnsubscribe([h('List-Unsubscribe', '<mailto:not-an-address>')])).toBeNull();
  });

  test('skips an invalid mailto and keeps the next valid one', () => {
    const r = assertParsed(
      parseListUnsubscribe([
        h('List-Unsubscribe', '<mailto:a@x.example,b@y.example>, <mailto:ok@x.example>'),
      ]),
    );
    expect(r.mailto).toEqual({ address: 'ok@x.example', subject: null });
  });

  test('drops a mailto whose subject has control characters', () => {
    const r = assertParsed(
      parseListUnsubscribe([
        h(
          'List-Unsubscribe',
          '<mailto:u@x.example?subject=hi%0D%0ABcc:%20v@y.example>, <https://x.example/u>',
        ),
      ]),
    );
    expect(r).toEqual({ oneClick: false, url: 'https://x.example/u', mailto: null });
  });

  test('drops a mailto whose subject exceeds the length cap', () => {
    const long = 'a'.repeat(MAX_MAILTO_SUBJECT_LENGTH + 1);
    expect(
      parseListUnsubscribe([h('List-Unsubscribe', `<mailto:u@x.example?subject=${long}>`)]),
    ).toBeNull();
    const ok = 'a'.repeat(MAX_MAILTO_SUBJECT_LENGTH);
    const r = assertParsed(
      parseListUnsubscribe([h('List-Unsubscribe', `<mailto:u@x.example?subject=${ok}>`)]),
    );
    expect(r.mailto?.subject).toBe(ok);
  });

  test('matches header keys case-insensitively', () => {
    const r = assertParsed(parseListUnsubscribe([h('list-UNSUBSCRIBE', '<https://x.example/u>')]));
    expect(r.url).toBe('https://x.example/u');
  });

  test('marks oneClick true only with List-Unsubscribe-Post AND an http(s) url', () => {
    const r = assertParsed(
      parseListUnsubscribe([
        h('List-Unsubscribe', '<https://x.example/u>'),
        h('List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'),
      ]),
    );
    expect(r.oneClick).toBe(true);
    expect(r.url).toBe('https://x.example/u');
  });

  test('matches the List-Unsubscribe-Post value case-insensitively', () => {
    const r = assertParsed(
      parseListUnsubscribe([
        h('List-Unsubscribe', '<https://x.example/u>'),
        h('list-unsubscribe-post', 'list-unsubscribe=ONE-CLICK'),
      ]),
    );
    expect(r.oneClick).toBe(true);
  });

  test('does not set oneClick when the Post header value is unexpected', () => {
    const r = assertParsed(
      parseListUnsubscribe([
        h('List-Unsubscribe', '<https://x.example/u>'),
        h('List-Unsubscribe-Post', 'something-else'),
      ]),
    );
    expect(r.oneClick).toBe(false);
  });

  test('does not set oneClick when there is only a mailto (no http url)', () => {
    const r = assertParsed(
      parseListUnsubscribe([
        h('List-Unsubscribe', '<mailto:unsub@x.example>'),
        h('List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'),
      ]),
    );
    expect(r.oneClick).toBe(false);
    expect(r.mailto?.address).toBe('unsub@x.example');
  });

  test('skips malformed/garbage URIs but keeps usable ones', () => {
    const r = assertParsed(
      parseListUnsubscribe([
        h('List-Unsubscribe', '<not a url>, <ht!tp://bad>, <https://x.example/u>'),
      ]),
    );
    expect(r.url).toBe('https://x.example/u');
  });

  test('never throws on garbage values', () => {
    expect(() => parseListUnsubscribe([h('List-Unsubscribe', '<<<>>><')])).not.toThrow();
    expect(() => parseListUnsubscribe([h('List-Unsubscribe', 'mailto:')])).not.toThrow();
    expect(parseListUnsubscribe([h('List-Unsubscribe', '<mailto:>')])).toBeNull();
  });

  test('tolerates malformed entries in the array (missing key/value)', () => {
    const r = assertParsed(
      parseListUnsubscribe([
        null,
        { key: 'List-Unsubscribe' },
        { value: '<https://x.example/u>' },
        h('List-Unsubscribe', '<https://x.example/u>'),
      ]),
    );
    expect(r.url).toBe('https://x.example/u');
  });
});

describe('isSafeUnsubscribeUrl', () => {
  test('accepts a public https url', () => {
    expect(isSafeUnsubscribeUrl('https://x.example/u?t=1')).toBe(true);
    expect(isSafeUnsubscribeUrl('https://sub.domain.example.com/path')).toBe(true);
  });

  test('rejects non-string / unparseable input without throwing', () => {
    expect(isSafeUnsubscribeUrl('not a url')).toBe(false);
    expect(isSafeUnsubscribeUrl('')).toBe(false);
    expect(isSafeUnsubscribeUrl(null)).toBe(false);
    expect(isSafeUnsubscribeUrl(undefined)).toBe(false);
  });

  test('rejects non-https schemes', () => {
    expect(isSafeUnsubscribeUrl('http://x.example/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('mailto:unsub@x.example')).toBe(false);
    expect(isSafeUnsubscribeUrl('ftp://x.example/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('file:///etc/passwd')).toBe(false);
  });

  test('rejects localhost and localhost subdomains', () => {
    expect(isSafeUnsubscribeUrl('https://localhost/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://api.localhost/u')).toBe(false);
  });

  test('rejects IPv4 literals including private and link-local ranges', () => {
    expect(isSafeUnsubscribeUrl('https://127.0.0.1/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://10.0.0.1/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://192.168.1.1/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://172.16.0.1/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://8.8.8.8/u')).toBe(false);
  });

  test('rejects IPv6 literals (bracketed)', () => {
    expect(isSafeUnsubscribeUrl('https://[::1]/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://[2001:db8::1]/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://[fe80::1]/u')).toBe(false);
  });

  test('rejects numeric-shorthand and decimal IP forms', () => {
    expect(isSafeUnsubscribeUrl('https://127.1/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://2130706433/u')).toBe(false);
  });

  test('rejects embedded credentials', () => {
    expect(isSafeUnsubscribeUrl('https://user:pass@x.example/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://user@x.example/u')).toBe(false);
  });

  test('rejects explicit non-default ports', () => {
    expect(isSafeUnsubscribeUrl('https://x.example:8443/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://x.example:80/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://x.example:8080/u')).toBe(false);
  });

  test('allows an explicit default https port (normalized away by URL)', () => {
    // :443 is the https default; the URL parser drops it, so port is empty.
    expect(isSafeUnsubscribeUrl('https://x.example:443/u')).toBe(true);
  });

  test('rejects single-label hostnames', () => {
    expect(isSafeUnsubscribeUrl('https://intranet/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://server/u')).toBe(false);
  });

  test('rejects internal-style suffixes', () => {
    expect(isSafeUnsubscribeUrl('https://printer.local/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://db.internal/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://host.lan/u')).toBe(false);
    expect(isSafeUnsubscribeUrl('https://svc.home.arpa/u')).toBe(false);
  });
});
