import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // Unit tests only (fast, free). The on-chain bench (test-onchain/**) runs via vitest.onchain.config.ts.
    include: ['src/**/*.test.ts'],
  },
});
