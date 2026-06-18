'use client';

import type { PositionEvent, PositionEventKind } from '@meteora/shared';
import { fmtAmount, fmtDateTime } from '@/domain/format';
import { cn } from '@/presentation/ui';

const KIND_META: Record<PositionEventKind, { label: string; dot: string }> = {
  open: { label: 'Opened', dot: 'bg-info' },
  deposit: { label: 'Deposit', dot: 'bg-accent' },
  withdraw: { label: 'Withdraw', dot: 'bg-warn' },
  claim: { label: 'Claim fees', dot: 'bg-profit' },
  close: { label: 'Closed', dot: 'bg-faint' },
};

type Props = { events: PositionEvent[]; symbolX: string; symbolY: string };

/** Vertical event timeline (newest first), reconstructed from on-chain history. */
export function HistoryTimeline({ events, symbolX, symbolY }: Props) {
  const ordered = [...events].reverse();
  return (
    <ol className="relative ml-1 border-border border-l">
      {ordered.map((e, i) => {
        const meta = KIND_META[e.kind];
        const amounts = [
          e.amountX !== 0 ? `${fmtAmount(e.amountX)} ${symbolX}` : null,
          e.amountY !== 0 ? `${fmtAmount(e.amountY)} ${symbolY}` : null,
        ].filter(Boolean);
        return (
          <li key={`${e.signature}-${e.kind}-${i}`} className="relative py-2.5 pl-5">
            <span className={cn('-left-[5px] absolute top-3.5 size-2 rounded-full', meta.dot)} />
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm text-text">{meta.label}</span>
              <span className="text-faint text-xs">{fmtDateTime(e.at)}</span>
            </div>
            {amounts.length > 0 && (
              <div className="tabular text-muted text-xs">{amounts.join(' · ')}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
