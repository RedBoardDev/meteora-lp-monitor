'use client';

import type { ClosedPosition } from '@binsight/shared';
import { type MouseEvent, useState } from 'react';
import { cn, IconShare } from '@/presentation/ui';
import { ShareCardModal } from './share-card-modal';

/**
 * A discreet share affordance for a closed position. Opens a modal with the position summary, the
 * generated PnL card and share / copy / download actions. Stops propagation so a click inside a
 * position row never also opens the detail drawer.
 */
export function ShareCardButton({
  position,
  className,
}: {
  position: ClosedPosition;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="Share PnL card"
        aria-label="Share PnL card"
        className={cn(
          'rounded-md p-1.5 text-faint transition-all hover:bg-surface-2 hover:text-accent',
          className,
        )}
      >
        <IconShare className="size-4" />
      </button>
      <ShareCardModal position={position} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
