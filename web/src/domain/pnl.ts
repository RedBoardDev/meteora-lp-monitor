import type { NetworthCurvePoint } from '@binsight/shared';
import { PERIOD_OPTIONS, type Period, sinceMs } from './period';

/** Short label for the selected period (e.g. "1M") — used in the "Gain (1M)" caption. */
export function periodLabel(period: Period): string {
  return PERIOD_OPTIONS.find((o) => o.value === period)?.label ?? period.toUpperCase();
}

/**
 * Real PnL gain over `period` = realPnl(now) − realPnl(start of period), where realPnl = performance
 * NET of apports (deposits/withdrawals). CAN be negative. Null when the curve has no point on/before
 * the period floor or the live net worth is unknown. The single source of truth for this headline —
 * SummaryCard and PnlBridge both call it, so the two displayed numbers can never drift.
 *
 * realPnlNow uses the LIVE net worth (walletTotalSol) minus the cumulative apports of the LAST curve
 * point — NOT points[last].realPnl: today's at-cost reconstruction lags the live tx stream (a fresh
 * deposit hits the cash ledger before its position shows up in the legs).
 */
export function realPnlGain(
  points: NetworthCurvePoint[],
  period: Period,
  now: number,
  walletTotalSol: number | null,
): number | null {
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
