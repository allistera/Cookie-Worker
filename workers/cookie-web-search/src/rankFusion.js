// Ported from Cookie-Web's api/_lib/rank-fusion.js, unchanged.
// Reciprocal Rank Fusion: merges several ranked id lists into one list,
// scoring each id by the sum of 1/(k + rank) across the lists it appears in.
// Ids ranked well by multiple lists float to the top; k dampens how much a
// single #1 spot dominates.

const DEFAULT_K = 60;

export function fuseRankings(rankings, k = DEFAULT_K) {
  const scores = new Map();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
