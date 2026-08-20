import { describe, expect, it } from 'vitest';
import { fuseRankings } from '../src/rankFusion.js';

describe('fuseRankings', () => {
  it('returns a single ranking unchanged', () => {
    expect(fuseRankings([['a', 'b', 'c']])).toEqual(['a', 'b', 'c']);
  });

  it('ranks ids appearing in both lists above single-list ids', () => {
    const fused = fuseRankings([
      ['a', 'b', 'c'],
      ['x', 'b', 'y'],
    ]);
    expect(fused[0]).toBe('b');
    expect(fused).toHaveLength(5);
  });

  it('deduplicates ids across lists', () => {
    const fused = fuseRankings([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(fused.sort()).toEqual(['a', 'b']);
  });

  it('handles empty rankings', () => {
    expect(fuseRankings([])).toEqual([]);
    expect(fuseRankings([[], []])).toEqual([]);
    expect(fuseRankings([['a'], []])).toEqual(['a']);
  });

  it('breaks ties by first-list order', () => {
    const fused = fuseRankings([['a', 'b'], []]);
    expect(fused).toEqual(['a', 'b']);
  });
});
