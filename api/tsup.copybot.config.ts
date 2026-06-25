import { defineConfig } from 'tsup';

/**
 * Build dédié aux process du copy-bot (brain / coffre / outils de validation). Contrairement au build de
 * l'API (`tsup.config.ts`, deps externalisées), ici on **bundle TOUT** (`noExternal`) : le SDK Meteora et
 * anchor ont des builds ESM/CJS cassés en consommation directe (dir-imports, défaut manquant) — seul un
 * bundle esbuild complet résout l'interop. Seuls les modules NATIFS restent externes.
 */
export default defineConfig({
  // Committed build = the production brain + the on-chain bench's two CLIs (leader-control drives the leader-test
  // wallet, bench-reader reads positions/fidelity). Local-only scratch tools (diag-*, build-faithful-sim) are NOT
  // referenced here so the committed build never depends on gitignored scripts.
  entry: ['scripts/leader-control.ts', 'scripts/bench-reader.ts', 'src/copybot/brain/brain-main.ts'],
  format: ['cjs'], // CJS : un bundle CJS gère `require()` des builtins (ESM casse sur les deps CJS du SDK)
  target: 'node22',
  platform: 'node',
  outDir: 'dist/copybot',
  clean: true,
  noExternal: [/.*/], // tout bundler (SDK + anchor + web3 + …)
  external: ['bigint-buffer'], // module natif → laissé en require runtime
  esbuildOptions(options) {
    options.alias = { '@': new URL('./src', import.meta.url).pathname };
  },
});
