import type { ClosedPosition, Stats } from '@meteora/shared';

/** Pure aggregation of closed positions into the analytics DTO. */
export function computeStats(scope: string, closed: ClosedPosition[]): Stats {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayStartMs = startOfToday.getTime();

  let wins = 0;
  let totalPnl = 0;
  let totalFees = 0;
  let totalVolume = 0;
  let todayPnl = 0;
  let durationSum = 0;
  let durationCount = 0;
  const cumulativePnl: { t: number; pnl: number }[] = [];
  const byPairMap = new Map<string, { pnlSol: number; count: number }>();

  for (const p of closed) {
    if (p.pnlSol > 0) wins++;
    totalPnl += p.pnlSol;
    totalFees += p.feesSol;
    totalVolume += p.depositSol;
    if (p.durationSeconds != null) {
      durationSum += p.durationSeconds;
      durationCount++;
    }
    if (p.closedAt != null) {
      cumulativePnl.push({ t: p.closedAt, pnl: totalPnl });
      if (p.closedAt >= todayStartMs) todayPnl += p.pnlSol;
    }

    const pair = `${p.tokenX}/${p.tokenY}`;
    const agg = byPairMap.get(pair) ?? { pnlSol: 0, count: 0 };
    agg.pnlSol += p.pnlSol;
    agg.count++;
    byPairMap.set(pair, agg);
  }

  const closedCount = closed.length;
  const byPair = [...byPairMap.entries()]
    .map(([pair, v]) => ({ pair, pnlSol: v.pnlSol, count: v.count }))
    .sort((a, b) => b.pnlSol - a.pnlSol);

  return {
    scope,
    closedCount,
    wins,
    losses: closedCount - wins,
    winRate: closedCount > 0 ? (wins / closedCount) * 100 : 0,
    totalPnlSol: totalPnl,
    todayPnlSol: todayPnl,
    totalFeesSol: totalFees,
    totalVolumeSol: totalVolume,
    avgDurationSeconds: durationCount > 0 ? durationSum / durationCount : 0,
    cumulativePnl,
    byPair,
  };
}
