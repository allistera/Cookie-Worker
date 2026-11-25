import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = resolve(process.cwd(), 'migrations');

// Prefixes that were shipped twice before this guard existed. They are
// already applied, so they stay; every later number must be unique.
const HISTORICAL_DUPLICATES = new Set(['0018', '0076']);

describe('migration numbering', () => {
  it('gives every new migration a unique number prefix', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => /^\d+_.*\.sql$/.test(name));
    const byPrefix = new Map();
    for (const name of files) {
      const prefix = name.split('_')[0];
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
    }

    const duplicates = [...byPrefix]
      .filter(([prefix, names]) => names.length > 1 && !HISTORICAL_DUPLICATES.has(prefix))
      .map(([, names]) => names);

    expect(duplicates).toEqual([]);
  });
});
