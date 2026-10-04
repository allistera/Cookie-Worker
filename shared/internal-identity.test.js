import { describe, expect, test } from 'vitest';
import { internalCaller, runAsInternalCaller } from './internal-identity.js';

describe('internal identity scope', () => {
  test('is empty outside a scope', () => {
    expect(internalCaller()).toBeUndefined();
  });

  test('carries the identity through awaits inside the scope only', async () => {
    const seen = await runAsInternalCaller({ userId: 'u-1', email: 'a@example.com' }, async () => {
      await Promise.resolve();
      return internalCaller();
    });
    expect(seen).toEqual({ userId: 'u-1', email: 'a@example.com' });
    expect(internalCaller()).toBeUndefined();
  });

  test('rejects an identity without a user id or email', () => {
    expect(() => runAsInternalCaller({ userId: '', email: 'a@example.com' }, () => 1)).toThrow();
    expect(() => runAsInternalCaller(/** @type {any} */ ({ userId: 'u' }), () => 1)).toThrow();
  });
});
