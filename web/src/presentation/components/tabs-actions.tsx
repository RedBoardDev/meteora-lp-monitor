'use client';

import { useState } from 'react';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { shortAddr } from '@/domain/format';
import { api } from '@/infrastructure/api/client';
import { useCopy } from '@/presentation/hooks/use-copy';
import { cn, IconCheck, IconCopy, IconRefresh } from '@/presentation/ui';

/** Sits to the right of the Tabs row: the scoped wallet address pill (copy) + a force-refresh button.
 *  No "updated" timestamp — the socket stream is real-time, so relative time is noise. */
export function TabsActions() {
  const scope = usePortfolio((s) => s.scope);
  const { copied, copy } = useCopy();
  const [spinning, setSpinning] = useState(false);

  async function refresh() {
    if (spinning) return; // ignore re-clicks while a refresh is already in flight
    setSpinning(true);
    try {
      await api.refresh();
    } catch {
      /* surfaced via the health indicator — don't wedge the button */
    } finally {
      setSpinning(false); // spin tracks the REAL request, and never sticks on error
    }
  }

  return (
    <div className="flex items-center gap-2 pb-1.5">
      {scope !== 'all' && (
        <button
          type="button"
          onClick={() => copy(scope)}
          title="Copy wallet address"
          className="tabular inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1 font-medium text-muted text-xs transition-colors hover:bg-hover hover:text-text"
        >
          {shortAddr(scope, 5, 5)}
          {copied ? <IconCheck className="text-profit" /> : <IconCopy />}
        </button>
      )}
      <button
        type="button"
        onClick={refresh}
        aria-label="Force refresh"
        className="rounded-md p-1.5 text-muted transition-colors hover:bg-hover hover:text-text"
      >
        <IconRefresh className={cn(spinning && 'animate-spin')} />
      </button>
    </div>
  );
}
