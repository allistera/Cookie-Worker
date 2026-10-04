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
    restoreMocks: true,
    clearMocks: true,
  },
});
