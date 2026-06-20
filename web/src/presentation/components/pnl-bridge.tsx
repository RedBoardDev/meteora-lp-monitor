'use client';

import type { NetworthCurvePoint } from '@binsight/shared';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { useUi } from '@/application/stores/ui-store';
import { PERIOD_OPTIONS, type Period, periodDays, sinceMs } from '@/domain/period';
import { toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useMoney } from '@/presentation/hooks/use-money';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import { cn, Skeleton, SolMark, toneText } from '@/presentation/ui';

/** Short label for the selected period (e.g. "1M") — used in the band caption. */
function periodLabel(period: Period): string {
  return PERIOD_OPTIONS.find((o) => o.value === period)?.label ?? period.toUpperCase();
}

/** Real PnL gain over `period` = realPnl(now) − realPnl(start of period), where realPnl = performance
 *  net of apports (deposits/withdrawals). CAN be negative. Null when the curve has no point on/before the
 *  period floor or the live net worth is unknown. */
function realPnlGain(
  points: NetworthCurvePoint[],
  period: Period,
  now: number,
  walletTotalSol: number | null,
): number | null {
  // realPnlNow uses the LIVE net worth (walletTotalSol) minus the cumulative apports of the last curve
  // point — NOT points[last].realPnl: today's at-cost reconstruction lags the live tx stream (a fresh
  // deposit hits the cash ledger before its position shows up in the legs).
  if (points.length === 0 || walletTotalSol == null) return null;
  const apportsLast = points.at(-1)?.apports ?? 0;
  const realPnlNow = walletTotalSol - apportsLast;
  const floor = sinceMs(period, now);
  const start =
    floor <= 0
      ? points[0]?.realPnl
      : points.find((p) => Date.parse(`${p.date}T00:00:00Z`) >= floor)?.realPnl;
  return start == null ? null : realPnlNow - start;
}

/**
 * The PnL reconciliation band — the headline that resolves the app's most confusing duality. The HERO
 * is the wallet's REAL PnL gain over the selected period (performance NET of apports = deposits/with-
 * drawals, end − start), which CAN be negative; beside it, two stat cells reconcile the per-position
 * story — `marked at close` (mark-at-close / LPAgent parity) and `trading cash-flow` (the on-chain
 * realized SOL over the same window, which books post-close bleed the per-position view never sees). It
 * shares the metric grid's columns so it reads as one coherent header, not a separate box.
 */
export function PnlBridge({ positionsPnl }: { positionsPnl: number }) {
  const scope = usePortfolio((s) => s.scope);
  const closedVersion = usePortfolio((s) => s.closedVersion);
  const nwNow = usePortfolio((s) => s.portfolio?.totals.walletTotalSol ?? null);
  const period = useUi((s) => s.period);
  const days = periodDays(period, Date.now());
  const { data: networth, loading: nwLoading } = useScopedQuery(
    () => api.networthCurve(scope, days),
    [scope, closedVersion, period],
  );
  const { data: curve } = useScopedQuery(
    () => api.walletPnlCurve(scope, days),
    [scope, closedVersion, period],
  );

  const m = useMoney();
  if (nwLoading && !networth) return <Skeleton className="h-[88px] w-full rounded-lg" />;
  if (!networth) return null;

  const gain = realPnlGain(networth.points, period, Date.now(), nwNow);
  const trading = curve?.totalTradingSol ?? null;

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
      <div className="col-span-2 sm:col-span-3 lg:col-span-2">
        <span className="font-medium text-faint text-xs uppercase tracking-wide">
          PnL réel ({periodLabel(period)}){curve && !curve.complete && ' · indexing…'}
          <span
            title="Your REAL PnL over the period: realPnl(now) − realPnl(start), where real PnL = your wallet value NET of apports (deposits/withdrawals). It can be negative (you injected more than your current value). Verified on-chain."
            role="img"
            aria-label="How the real PnL gain is computed"
            className="ml-2 inline-grid size-4 cursor-help place-items-center rounded-full border border-border align-middle text-[10px] text-faint"
          >
            i
          </span>
        </span>
        <span
          className={cn(
            'tabular mt-1.5 flex items-center gap-1.5 font-semibold text-4xl leading-none',
            toneText[gain != null ? toneOf(gain) : 'neutral'],
          )}
        >
          {gain != null ? m.sol(gain, { signed: true }) : '—'}
          {m.showGlyph && gain != null && <SolMark size={20} />}
        </span>
      </div>

      <Leg label="Marked at close" value={positionsPnl} />
      <Leg label="Trading cash-flow" value={trading} />
    </div>
  );
}

/** A reconciliation leg, styled to match the metric cells: a tone dot + label, then the signed SOL
 *  value (no glyph — the hero carries the only one, keeping the row calm). */
function Leg({ label, value }: { label: string; value: number | null }) {
  const m = useMoney();
  const tone = value != null ? toneOf(value) : 'neutral';
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
        {value != null ? m.sol(value, { signed: true }) : '—'}
      </span>
    </div>
  );
}
