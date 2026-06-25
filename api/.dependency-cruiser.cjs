/**
 * Copy-bot — import-firewall (machine-checké). Garantit l'isolation de la zone coffre :
 *  F1 : SEUL le coffre importe la clé (`coffre/keypair.ts`) — le brain ne peut pas nommer la clé.
 *  F3 : le coffre n'importe PAS le SDK DLMM (ni les modules qui le chargent) — Wall B re-décode sans le SDK.
 * Lancé depuis api/ :  yarn depcruise src/copybot --config .dependency-cruiser.cjs
 */
module.exports = {
  forbidden: [
    {
      name: 'F1-only-coffre-imports-keypair',
      comment: 'La clé privée ne se charge que dans le coffre.',
      severity: 'error',
      from: { pathNot: 'src/copybot/coffre/' },
      to: { path: 'src/copybot/coffre/keypair\\.ts$' },
    },
    {
      name: 'F3-no-dlmm-sdk-in-coffre',
      comment: 'Le coffre ne charge jamais le SDK DLMM (firewall F3) ; Wall B décode à la main.',
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
