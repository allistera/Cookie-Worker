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
      include: ['workers/*/src/**/*.js', 'shared/**/*.js'],
      exclude: ['**/__tests__/**', '**/*.{test,spec}.js'],
      reporter: ['text', 'json', 'json-summary', 'lcov'],
      thresholds: {
        perFile: true,
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
    restoreMocks: true,
    clearMocks: true,
  },
});
