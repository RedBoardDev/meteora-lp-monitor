/**
 * Copy-bot · P3 — EXACT re-anchoring of the bin shape (PURE, no I/O). This is the core of FAITHFUL copying:
 * we reproduce the same liquidity PROPORTIONS per bin as the leader, shifted to stay relative to the
 * active bin (the leader may have opened at a different active bin than ours). Output = weights per bin (BPS of total),
 * to be passed to the SDK's by-weight add (`xYAmountDistribution`).
 *
 * v1 = SOL one-sided: we replicate the distribution of the leader's SOL SIDE and deposit OUR sized SOL according to those
 * weights (two-sided positions / swap = later extension). `delta = ourActive − leaderActive` shifts all
 * the bins, so the shape stays anchored on the current active bin.
 */
const BPS_TOTAL = 10_000;

/** Leader's SOL-side liquidity in a bin (raw), ABSOLUTE bin of its position. */
export interface LeaderBinAmount {
  binId: number;
  amount: bigint;
}

/** Re-anchored weight: bin relative to OUR active bin + share of the total in BPS (the sum of weights == 10000). */
export interface BinWeight {
  binId: number;
  bps: number;
}

export interface ReanchoredShape {
  weights: BinWeight[];
  lowerBinId: number;
  upperBinId: number;
}

/**
 * Re-anchors the leader's shape onto our active bin. Preserves the relative offsets (delta) AND the liquidity
 * proportions (BPS, exact sum = 10000 via the largest-remainder method). Pure.
 */
export function reanchorShape(
  leaderActiveBinId: number,
  ourActiveBinId: number,
  perBin: LeaderBinAmount[],
): ReanchoredShape {
  const nonZero = perBin.filter((b) => b.amount > 0n);
  if (nonZero.length === 0) throw new Error('reanchorShape: no SOL-side liquidity to copy');

  const total = nonZero.reduce((sum, b) => sum + b.amount, 0n);
  const delta = ourActiveBinId - leaderActiveBinId;

  // Proportional BPS (floor) + exact remainder, to then distribute the missing units.
  const entries = nonZero.map((b) => {
    const scaled = b.amount * BigInt(BPS_TOTAL);
    return { binId: b.binId + delta, bps: Number(scaled / total), rem: scaled % total };
  });

  // Largest remainder: we add the missing BPS to the bins with the largest remainder → sum == 10000.
  // (the deficit is < number of bins, each floor losing < 1 BPS → a single pass suffices.)
  let deficit = BPS_TOTAL - entries.reduce((sum, e) => sum + e.bps, 0);
  const byRemainder = [...entries].sort((a, b) => Number(b.rem - a.rem)); // descending remainder (branchless)
  for (const e of byRemainder) {
    if (deficit <= 0) break;
    e.bps += 1;
    deficit -= 1;
  }

  // The RANGE spans EVERY bin carrying liquidity, even a lowest/highest sliver that rounds to 0 bps. Dropping
  // such an EDGE bin would shift our lower/upper by one and permanently misalign every reshape (position-adjust
  // aligns leader.lower ↔ our.lower). Keep the edge bins as 0-weight entries so our range equals the leader's;
  // INTERIOR 0-bps bins are re-filled by fillContiguousWeights, so we still drop them here.
  const lowerBinId = Math.min(...entries.map((e) => e.binId));
  const upperBinId = Math.max(...entries.map((e) => e.binId));
  const weights = entries
    .filter((e) => e.bps > 0 || e.binId === lowerBinId || e.binId === upperBinId)
    .map((e) => ({ binId: e.binId, bps: e.bps }));
  return { weights, lowerBinId, upperBinId };
}
