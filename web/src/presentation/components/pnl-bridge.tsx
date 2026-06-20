'use client';

import { usePortfolio } from '@/application/stores/portfolio-store';
import { useUi } from '@/application/stores/ui-store';
import { periodDays } from '@/domain/period';
import { toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useMoney } from '@/presentation/hooks/use-money';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import { cn, Skeleton, SolMark, toneText } from '@/presentation/ui';

/**
 * The PnL reconciliation band — the headline that resolves the app's most confusing duality. The HERO
 * is the wallet's TRUE on-chain SOL result (spanning two columns); beside it, two stat cells tell the
 * story of the gap — `marked at close` (mark-at-close / LPAgent parity) and `lost after close` (the
 * post-close bleed = wallet − positions, which the per-position view never sees). It shares the metric
 * grid's columns so it reads as one coherent header, not a separate box.
 */
export function PnlBridge({ positionsPnl }: { positionsPnl: number }) {
  const scope = usePortfolio((s) => s.scope);
  const closedVersion = usePortfolio((s) => s.closedVersion);
  const period = useUi((s) => s.period);
  const { data: curve, loading } = useScopedQuery(
    () => api.walletPnlCurve(scope, periodDays(period, Date.now())),
    [scope, closedVersion, period],
  );

  const m = useMoney();
  if (loading && !curve) return <Skeleton className="h-[88px] w-full rounded-lg" />;
  if (!curve) return null;

  const wallet = curve.totalTradingSol;
  const postClose = wallet - positionsPnl;

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
      <div className="col-span-2 sm:col-span-3 lg:col-span-2">
        <span className="font-medium text-faint text-xs uppercase tracking-wide">
          Real PnL · on-chain{!curve.complete && ' · indexing…'}
          <span
            title="The wallet's TRUE realized SOL. Unlike the per-position 'mark-at-close' figure, it also books the loss from dumping leftover tokens AFTER a close (rugs / slippage). Post-close = wallet − positions."
            role="img"
            aria-label="How the real PnL is reconciled"
            className="ml-2 inline-grid size-4 cursor-help place-items-center rounded-full border border-border align-middle text-[10px] text-faint"
          >
            i
          </span>
        </span>
        <span
          className={cn(
            'tabular mt-1.5 flex items-center gap-1.5 font-semibold text-4xl leading-none',
            toneText[toneOf(wallet)],
          )}
        >
          {m.sol(wallet, { signed: true })}
          {m.showGlyph && <SolMark size={20} />}
        </span>
      </div>

      <Leg label="Marked at close" value={positionsPnl} />
      <Leg label="Lost after close" value={postClose} />
    </div>
  );
}

/** A reconciliation leg, styled to match the metric cells: a tone dot + label, then the signed SOL
 *  value (no glyph — the hero carries the only one, keeping the row calm). */
function Leg({ label, value }: { label: string; value: number }) {
  const m = useMoney();
  const tone = toneOf(value);
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 font-medium text-faint text-xs uppercase tracking-wide">
        <span
          className={cn(
            'size-1.5 rounded-full',
            tone === 'profit' ? 'bg-profit' : tone === 'loss' ? 'bg-loss' : 'bg-faint',
          )}
          aria-hidden="true"
        />
        {label}
      </span>
      <span className={cn('tabular font-semibold text-2xl leading-none', toneText[tone])}>
        {m.sol(value, { signed: true })}
      </span>
    </div>
  );
}
