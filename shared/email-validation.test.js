import { describe, expect, test } from 'vitest';
import { hasControlChars, isValidEmailAddress } from './email-validation.js';

describe('isValidEmailAddress', () => {
  test('accepts a single ordinary address', () => {
    expect(isValidEmailAddress('unsub+list@mail.example.com')).toBe(true);
  });

  test('rejects address lists, whitespace and CRLF injection', () => {
    expect(isValidEmailAddress('a@x.example,b@y.example')).toBe(false);
    expect(isValidEmailAddress('a@x.example b@y.example')).toBe(false);
    expect(isValidEmailAddress('a@x.example\r\nBcc: b@y.example')).toBe(false);
  });

  test('rejects missing or undotted domains and overlong addresses', () => {
    expect(isValidEmailAddress('a@localhost')).toBe(false);
    expect(isValidEmailAddress('no-at-sign')).toBe(false);
    expect(isValidEmailAddress(`${'a'.repeat(320)}@x.example`)).toBe(false);
  });
});

describe('hasControlChars', () => {
  test('flags C0 controls and DEL', () => {
    expect(hasControlChars('hi\r\nBcc: x')).toBe(true);
    expect(hasControlChars('tab\there')).toBe(true);
    expect(hasControlChars('del\u007f')).toBe(true);
  });

  test('allows ordinary and non-ASCII text', () => {
    expect(hasControlChars('Unsubscribe me — merci')).toBe(false);
  });
});
