import { describe, expect, test } from 'vitest';
import * as entrypoint from '../src/index.js';

describe('Cloudflare entrypoint', () => {
  test('exports only the Worker handler', () => {
    expect(Object.keys(entrypoint)).toEqual(['default']);
    expect(entrypoint.default).toEqual(
      expect.objectContaining({
        scheduled: expect.any(Function),
        fetch: expect.any(Function),
      }),
    );
  });
});
