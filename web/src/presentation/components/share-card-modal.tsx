'use client';

import type { ClosedPosition } from '@binsight/shared';
import { useCallback } from 'react';
import { fmtDuration } from '@/domain/format';
import { toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useMoney } from '@/presentation/hooks/use-money';
import { Badge, cn, toneText } from '@/presentation/ui';
import { ImageShareModal } from './image-share-modal';

/** Share dialog for a closed position: the position summary on top, then the generated PnL card with
 *  share / copy / download. A thin wrapper over the reusable ImageShareModal (the card PNG is rendered
 *  server-side and fetched through the authenticated proxy). */
export function ShareCardModal({
  position,
  open,
  onClose,
}: {
  position: ClosedPosition;
  open: boolean;
  onClose: () => void;
}) {
  const m = useMoney();
  const pair = `${position.tokenX}/${position.tokenY}`;
  const tone = toneOf(position.pnlSol);
  const filename = `pnl-${position.tokenX}-${position.tokenY}.png`.replace(/[^\w.-]+/g, '_');

  const getImage = useCallback(
    (signal?: AbortSignal) => api.positionCard(position.positionAddress, signal),
    [position.positionAddress],
  );

  return (
    <ImageShareModal
      open={open}
      onClose={onClose}
      title={pair}
      filename={filename}
      shareTitle={`${pair} — PnL`}
      aspect="3 / 2"
      getImage={getImage}
      summary={
        <div className="flex items-start justify-between gap-3">
          <div className={cn('tabular leading-tight', toneText[tone])}>
            <div className="font-semibold text-2xl">{m.sol(position.pnlSol, { signed: true })}</div>
            <div className="text-sm opacity-75">{m.pct(position.pnlPctSol)}</div>
          </div>
          <div className="flex flex-col items-end gap-1 text-faint text-xs">
            {position.strategy && <Badge>{position.strategy}</Badge>}
            <span>
              Fees {m.sol(position.feesSol)} · Invested {m.sol(position.depositSol)}
            </span>
            <span>Held {fmtDuration(position.durationSeconds)}</span>
          </div>
        </div>
      }
    />
  );
}
