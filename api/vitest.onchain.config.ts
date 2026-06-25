import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// On-chain bench: REAL transactions on the two test wallets. Separate from the unit config — slow, costs SOL,
// needs the bot. Gated by RUN_ONCHAIN=true (the test:onchain script) + a funded-wallet check in global-setup.
// Fully SEQUENTIAL: tests share 2 wallets + 1 bot, so no parallelism (single fork, no concurrent).
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test-onchain/**/*.onchain.test.ts'],
    globalSetup: ['./test-onchain/global-setup.ts'],
    testTimeout: 120_000, // a copy cycle (open→copy→assert) takes seconds; two-sided + reshape more
    hookTimeout: 120_000, // resetState (close→wait→sweep→wait-clean) is slow
    fileParallelism: false,
    sequence: { concurrent: false },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['verbose'],
  },
});
