/**
 * Wallet-level realized PnL from on-chain SOL cash-flow — the TRUE wallet reality, decoder-free.
 *
 * Position-level PnL (Meteora / LPAgent) stops at the close: it misses the SOL lost AFTER closing,
 * while the leftover token is sold (rugs, slippage). This model instead sums the wallet's own net
 * SOL movement (native + WSOL) across its DLMM + swap txs, day by day. A rug shows up exactly when
 * the dumped token comes back as far less SOL than was deployed. Every lamport is auditable: the sum
 * of all flows equals the wallet's actual SOL balance change over the window.
 *
 * External transfers (funding from / withdrawal to a CEX or another wallet — a plain SOL transfer
 * NOT part of a swap or DLMM action) are NOT trading PnL and are tracked separately, never mixed in.
 */

import type { WalletPnlDay } from '@binsight/shared';
import type { WalletTxFlow } from '@/domain/cashflow';

/** One day of the wallet PnL curve — the api→web contract type, canonical in @binsight/shared. */
export type CashflowDay = WalletPnlDay;

const dayOf = (tsSec: number): string => new Date(tsSec * 1000).toISOString().slice(0, 10);

/**
 * Aggregate per-tx flows into the daily PnL curve. Pure & deterministic. Days with no activity are
 * filled in (a flat curve segment) so the series is continuous — like LPAgent's graph.
 */
export function buildCashflowCurve(flows: WalletTxFlow[]): {
  days: CashflowDay[];
  totalTradingSol: number;
  totalExternalSol: number;
} {
  const trading = new Map<string, number>();
  const external = new Map<string, number>();
  for (const f of flows) {
    const d = dayOf(f.timestamp);
    const bucket = f.isTrading ? trading : external;
    bucket.set(d, (bucket.get(d) ?? 0) + f.solFlow);
  }
  return fillCurve(trading, external);
}

/**
 * Build the same continuous curve from per-day aggregates (the SQL-summed `wallet_flows` rows) instead
 * of raw per-tx flows. Lets the curve be served by a GROUP-BY-day query rather than re-paging the chain.
 */
export function buildCashflowCurveFromDaily(
  daily: { date: string; trading: number; external: number }[],
): { days: CashflowDay[]; totalTradingSol: number; totalExternalSol: number } {
  const trading = new Map<string, number>();
  const external = new Map<string, number>();
  for (const d of daily) {
    trading.set(d.date, d.trading);
    external.set(d.date, d.external);
  }
  return fillCurve(trading, external);
}

/** Gap-fill from the first to the last active UTC day and accumulate the trading flow into the curve. */
function fillCurve(
  trading: Map<string, number>,
  external: Map<string, number>,
): { days: CashflowDay[]; totalTradingSol: number; totalExternalSol: number } {
  let minDay: string | null = null;
  let maxDay: string | null = null;
  for (const d of trading.keys()) {
    if (minDay === null || d < minDay) minDay = d;
    if (maxDay === null || d > maxDay) maxDay = d;
  }
  for (const d of external.keys()) {
    if (minDay === null || d < minDay) minDay = d;
    if (maxDay === null || d > maxDay) maxDay = d;
  }

  const days: CashflowDay[] = [];
  let cumulative = 0;
  let cumulativeTotal = 0;
  let totalTradingSol = 0;
  let totalExternalSol = 0;
  if (minDay && maxDay) {
    for (
      let d = new Date(`${minDay}T00:00:00Z`);
      dayOf(d.getTime() / 1000) <= maxDay;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      const date = dayOf(d.getTime() / 1000);
      const tradingSol = trading.get(date) ?? 0;
      const externalSol = external.get(date) ?? 0;
      cumulative += tradingSol;
      cumulativeTotal += tradingSol + externalSol;
      totalTradingSol += tradingSol;
      totalExternalSol += externalSol;
      days.push({
        date,
        tradingSol,
        externalSol,
        cumulativeSol: cumulative,
        cumulativeTotalSol: cumulativeTotal,
      });
    }
  }
  return { days, totalTradingSol, totalExternalSol };
}
