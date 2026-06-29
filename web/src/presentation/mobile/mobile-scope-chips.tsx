'use client';

import { usePortfolio } from '@/application/stores/portfolio-store';
import { useWallets } from '@/application/stores/wallets-store';
import { shortAddr } from '@/domain/format';
import { cn } from '@/presentation/ui';

/** Horizontally-scrollable scope selector (Overview + one chip per wallet), like the iOS app. */
export function MobileScopeChips() {
  const scope = usePortfolio((s) => s.scope);
  const setScope = usePortfolio((s) => s.setScope);
  const wallets = useWallets((s) => s.wallets);

  // Nothing to switch between with 0 or 1 wallet — a single wallet makes "Overview" (the aggregate)
  // redundant since it equals that wallet — so the row is hidden until there are at least two.
  if (wallets.length <= 1) return null;

  const options = [
    { label: 'Overview', value: 'all' },
    ...wallets.map((w) => ({
      label: `${w.label || shortAddr(w.address)}${w.ready === false ? ' · indexing…' : ''}`,
      value: w.address,
    })),
  ];

  return (
    <div className="scrollbar-none flex gap-2 overflow-x-auto px-4 py-2">
      {options.map((o) => {
        const active = scope === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => setScope(o.value)}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 font-medium text-sm transition-colors',
              active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted active:bg-hover',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
