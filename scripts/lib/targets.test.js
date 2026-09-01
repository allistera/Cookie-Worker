import { describe, expect, it } from 'vitest';
import { DESCRIPTORS, TARGETS, parseTargets } from './targets.js';

describe('parseTargets', () => {
  it('defaults to every target when no argument is given', () => {
    expect(parseTargets([])).toEqual(['documents', 'messages', 'task_items']);
  });

  it('accepts "documents" alone', () => {
    expect(parseTargets(['documents'])).toEqual(['documents']);
  });

  it('accepts "messages" alone', () => {
    expect(parseTargets(['messages'])).toEqual(['messages']);
  });

  it('accepts "task_items" alone', () => {
    expect(parseTargets(['task_items'])).toEqual(['task_items']);
  });

  it('rejects an unknown target', () => {
    expect(() => parseTargets(['emails'])).toThrow(/Unknown target "emails"/);
  });

  it('ignores extra argv entries after the target', () => {
    expect(parseTargets(['messages', '--foo'])).toEqual(['messages']);
  });
});

describe('DESCRIPTORS', () => {
  it('has an entry for every target, keyed to match its own index name', () => {
    for (const target of TARGETS) {
      expect(DESCRIPTORS[target].name).toBe(target);
    }
  });
});
