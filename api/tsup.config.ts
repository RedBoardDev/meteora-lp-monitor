import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  outDir: 'dist',
  // Resolve the `@/*` alias to src/* at build time.
  esbuildOptions(options) {
    options.alias = { '@': new URL('./src', import.meta.url).pathname };
  },
});
