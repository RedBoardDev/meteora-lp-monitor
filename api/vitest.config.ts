import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // Unit tests only (fast, free): src/ units + the bench's PURE helpers (test-onchain/**/*.unit.test.ts, no chain/DB).
    // The on-chain bench (test-onchain/**/*.onchain.test.ts) runs via vitest.onchain.config.ts (needs RUN_ONCHAIN + funds).
    include: ['src/**/*.test.ts', 'test-onchain/**/*.unit.test.ts'],
  },
});
