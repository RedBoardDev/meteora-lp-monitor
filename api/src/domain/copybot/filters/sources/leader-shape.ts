/**
 * Copy-bot · PURE leader-shape projection. A DLMM position's price-range coverage (percent) =
 * `binCount × binStep(bps) / 100` — feeds the `minPriceRangePercent` filter (instant, no external call;
 * the leader shape is already read on-chain at open time). Spec `19` §2 (Valhalla "Min Bin Count").
 */
const BPS_PER_PERCENT = 100;

/** Range coverage in percent for a position spanning `binCount` bins at `binStepBps` per bin. */
export function rangeCoveragePercent(binCount: number, binStepBps: number): number {
  return (binCount * binStepBps) / BPS_PER_PERCENT;
}
