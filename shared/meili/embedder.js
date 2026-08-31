/**
 * Shared embedder settings. The model must match what the app embedded
 * before, so this migration changes where vectors come from and not which
 * model makes them.
 *
 * Its own module because both descriptors need it and meili.js re-exports
 * both descriptors: putting it in meili.js would be a cycle.
 */
export const EMBEDDER = {
  source: 'openAi',
  model: 'text-embedding-3-small',
  dimensions: 1536,
};
