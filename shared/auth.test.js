import { describe, expect, it } from 'vitest';
import { timingSafeEqualStrings } from './auth.js';

describe('shared secret comparison', () => {
  it.each([
    ['same-value', 'same-value', true],
    ['same-value', 'same-valuE', false],
    ['short', 'longer-value', false],
    ['', '', true],
    [undefined, null, true],
    [null, 'value', false],
    ['value', undefined, false],
    ['café', 'café', true],
  ])('compares %s and %s', async (left, right, expected) => {
    await expect(timingSafeEqualStrings(left, right)).resolves.toBe(expected);
  });
});
