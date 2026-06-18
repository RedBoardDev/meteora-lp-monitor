'use client';

import { usePortfolio } from '@/application/stores/portfolio-store';
import { useWallets } from '@/application/stores/wallets-store';

/**
 * Shown while a freshly-added wallet is still backfilling its on-chain history, so the user sees clear
 * progress instead of an empty/zeroed view. Scoped: only appears for the wallet(s) currently in view.
 */
export function IndexingBanner() {
  const scope = usePortfolio((s) => s.scope);
  const wallets = useWallets((s) => s.wallets);

  const indexing = wallets.filter((w) => w.ready === false);
  if (indexing.length === 0) return null;
  // For a single-wallet scope, only surface it when THAT wallet is the one indexing.
  if (scope !== 'all' && !indexing.some((w) => w.address === scope)) return null;

  const current = scope !== 'all' ? indexing.find((w) => w.address === scope) : undefined;
  const txs = current?.indexedTxs ?? indexing.reduce((n, w) => n + (w.indexedTxs ?? 0), 0);
  const title = current
    ? "Indexing this wallet's on-chain history…"
    : `Indexing ${indexing.length} wallet${indexing.length > 1 ? 's' : ''}…`;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-accent-soft/40 px-4 py-3">
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />
      <div className="flex min-w-0 flex-col">
        <span className="font-medium text-sm text-text">{title}</span>
        <span className="text-muted text-xs">
          {txs > 0 ? `${txs.toLocaleString()} transactions processed` : 'Reading the chain…'} · runs
          once, then stays live.
        </span>
      </div>
    </div>
  );
}
