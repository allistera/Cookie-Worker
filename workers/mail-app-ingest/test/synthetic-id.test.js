import { describe, expect, test } from 'vitest';
import { syntheticMessageId } from '../src/synthetic-id.js';

describe('syntheticMessageId', () => {
  test('is deterministic', async () => {
    const parts = { from: 'a', to: 'b', date: 'c', subject: 'd', bodyPrefix: 'e' };
    await expect(syntheticMessageId(parts)).resolves.toBe(await syntheticMessageId(parts));
  });

  test('changes when a component changes', async () => {
    await expect(syntheticMessageId({ subject: 'a' })).resolves.not.toBe(
      await syntheticMessageId({ subject: 'b' }),
    );
  });

  test('tolerates missing components', async () => {
    await expect(syntheticMessageId({})).resolves.toMatch(/^<synthetic-[a-f0-9]{64}@mail-app-ingest>$/u);
  });
});
