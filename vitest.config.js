import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./test/fixtures/cloudflare-workers.js', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      include: ['workers/*/src/**/*.js', 'shared/**/*.js'],
      exclude: ['**/__tests__/**', '**/test/**', '**/*.{test,spec}.js'],
      reporter: ['text', 'json', 'json-summary', 'lcov'],
    },
    restoreMocks: true,
    clearMocks: true,
  },
});
