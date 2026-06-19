'use client';

import type { PositionBins } from '@binsight/shared';
import { fmtAmount } from '@/domain/format';
import { cn, Tooltip } from '@/presentation/ui';

/**
 * Per-bin liquidity histogram. Bars below the current price are token-X (violet), bars at/above
 * are token-Y / SOL (cyan); a vertical marker + tooltip shows the live price — so the range is
 * read directly off the chart (no separate range bar needed).
 */
export function BinHistogram({ data }: { data: PositionBins }) {
  const values = data.bins.map((b) => b.amountY + b.amountX * b.price);
  const max = Math.max(1e-9, ...values);
  const first = data.bins.at(0);
  const last = data.bins.at(-1);

  const n = data.bins.length;
  const aboveIdx = data.bins.findIndex((b) => b.binId >= data.activeBinId);
  const fraction = aboveIdx < 0 ? 1 : aboveIdx / Math.max(1, n);
  const activePrice =
    data.bins.find((b) => b.binId === data.activeBinId)?.price ??
    (aboveIdx < 0 ? last?.price : first?.price);

  return (
    <div className="flex flex-col gap-2" role="img" aria-label={`Liquidity across ${n} price bins`}>
      <div className="relative flex h-36 items-end gap-px">
        {data.bins.map((b, i) => {
          const h = Math.max(2, (values[i]! / max) * 100);
          const below = b.binId < data.activeBinId;
          return (
            <div
              key={b.binId}
              className={cn('flex-1 rounded-t-[2px]', below ? 'bg-bin-x' : 'bg-bin-y')}
              style={{ height: `${h}%` }}
              title={fmtAmount(b.price)}
            />
          );
        })}

        <div
          className="pointer-events-none absolute inset-y-0 w-px bg-text/70"
          style={{ left: `${fraction * 100}%` }}
        />
        {activePrice != null && (
          <div
            className="pointer-events-none absolute top-0 -translate-x-1/2"
            style={{ left: `${Math.min(88, Math.max(12, fraction * 100))}%` }}
          >
            <Tooltip className="whitespace-nowrap px-2 py-1">
              <span className="text-faint">Current </span>
              <span className="tabular text-text">{fmtAmount(activePrice)}</span>
            </Tooltip>
          </div>
        )}
      </div>

      <div className="flex justify-between tabular text-faint text-xs">
        <span>{first ? fmtAmount(first.price) : '—'}</span>
        <span>{last ? fmtAmount(last.price) : '—'}</span>
      </div>
    </div>
  );
}
