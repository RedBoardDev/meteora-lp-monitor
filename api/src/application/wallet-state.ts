import type { OpenPosition, PortfolioTotals, WalletState } from '@meteora/shared';
import { isOutOfRange } from '@/domain/position';

export function buildTotals(positions: OpenPosition[], idleSol = 0): PortfolioTotals {
  let tvl = 0;
  let pnl = 0;
  let claimed = 0;
  let unclaimed = 0;
  let inRange = 0;
  let outOfRange = 0;
  for (const p of positions) {
    tvl += p.sizeSol;
    pnl += p.pnlSol;
    claimed += p.claimedFeesSol;
    unclaimed += p.unclaimedFeesSol;
    if (isOutOfRange(p.rangeStatus)) outOfRange++;
    else if (p.rangeStatus === 'in') inRange++;
  }
  const uPnlPct = tvl > 0 ? (pnl / tvl) * 100 : 0;
  return {
    uPnlSol: pnl,
    uPnlPct,
    feesSol: claimed + unclaimed,
    claimedFeesSol: claimed,
    unclaimedFeesSol: unclaimed,
    tvlSol: tvl,
    idleSol,
    walletTotalSol: tvl + idleSol,
    openCount: positions.length,
    inRangeCount: inRange,
    outOfRangeCount: outOfRange,
  };
}

export function buildWalletState(
  scope: string,
  positions: OpenPosition[],
  idleSol = 0,
): WalletState {
  const sorted = [...positions].sort((a, b) => b.pnlSol - a.pnlSol);
  return {
    scope,
    totals: buildTotals(sorted, idleSol),
    openPositions: sorted,
    updatedAt: Date.now(),
  };
}
