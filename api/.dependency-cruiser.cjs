/**
 * Copy-bot — import-firewall (machine-checked). Guarantees isolation of the coffre zone:
 *  F1: ONLY the coffre imports the key (`coffre/keypair.ts`) — the brain cannot name the key.
 *  F3: the coffre NEVER loads the DLMM SDK (nor the modules that load it) — Wall B re-decodes without the SDK.
 * Run from api/:  yarn depcruise src/copybot --config .dependency-cruiser.cjs
 */
module.exports = {
  forbidden: [
    {
      name: 'F1-only-coffre-imports-keypair',
      comment: 'The private key is only loaded inside the coffre.',
      severity: 'error',
      from: { pathNot: 'src/copybot/coffre/' },
      to: { path: 'src/copybot/coffre/keypair\\.ts$' },
    },
    {
      name: 'F3-no-dlmm-sdk-in-coffre',
      comment: 'The coffre never loads the DLMM SDK (firewall F3); Wall B decodes by hand.',
      severity: 'error',
      from: { path: 'src/copybot/coffre/' },
      to: {
        path: '(@meteora-ag/dlmm|src/infrastructure/solana/dlmm/(dlmm-tx-builder|leader-position-reader))',
      },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src/',
  },
};
