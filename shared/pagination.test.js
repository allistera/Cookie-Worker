import { describe, expect, it, vi } from 'vitest';
import { decodeCursor, encodeCursor, timestamp, validId, validTimestamp } from './pagination.js';

describe('pagination cursors', () => {
  it('round trips structured values through an unpadded URL-safe cursor', () => {
    const value = { at: '2026-10-21T00:00:00.000Z', id: 'item-1', text: '>?~' };
    const cursor = encodeCursor(value);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const validate = vi.fn(() => true);
    expect(decodeCursor(cursor, validate)).toEqual(value);
    expect(validate).toHaveBeenCalledWith(value);
  });

  it.each([undefined, null, ''])('treats %s as no cursor', (value) => {
    const validate = vi.fn();
    expect(decodeCursor(value, validate)).toBeNull();
    expect(validate).not.toHaveBeenCalled();
  });

  it('rejects oversized cursors before parsing or validating', () => {
    const validate = vi.fn();
    expect(() => decodeCursor('a'.repeat(2049), validate)).toThrow('Invalid cursor');
    expect(validate).not.toHaveBeenCalled();
  });

  it('accepts a valid cursor at the size boundary', () => {
    const value = 'a'.repeat(1534);
    const cursor = encodeCursor(value);
    expect(cursor).toHaveLength(2048);
    expect(decodeCursor(cursor, (decoded) => typeof decoded === 'string')).toBe(value);
  });

  it('rejects decoded data that does not match the caller schema', () => {
    expect(() => decodeCursor(encodeCursor({ id: 42 }), (value) => validId(value.id))).toThrow(
      'Invalid cursor',
    );
  });

  it.each(['%', btoa('not json')])('rejects malformed cursor %s', (cursor) => {
    const validate = vi.fn();
    expect(() => decodeCursor(cursor, validate)).toThrow();
    expect(validate).not.toHaveBeenCalled();
  });
});

describe('pagination field validation', () => {
  it.each(['01234567-89ab-cdef-0123-456789abcdef', '01234567-89AB-CDEF-0123-456789ABCDEF'])(
    'accepts UUID %s',
    (value) => expect(validId(value)).toBe(true),
  );

  it.each([
    null,
    42,
    '',
    '01234567-89ab-cdef-0123-456789abcdeg',
    '0123456789abcdef0123456789abcdef',
  ])('rejects invalid ID %s', (value) => expect(validId(value)).toBe(false));

  it('validates timestamp strings and normalizes Date objects', () => {
    const iso = '2026-10-21T12:34:56.000Z';
    expect(validTimestamp(iso)).toBe(true);
    expect(validTimestamp('not a date')).toBe(false);
    expect(validTimestamp(null)).toBe(false);
    expect(validTimestamp(new Date(iso))).toBe(false);
    expect(timestamp(new Date(iso))).toBe(iso);
    expect(timestamp(iso)).toBe(iso);
    expect(timestamp(null)).toBeNull();
  });
});
