/**
 * Copy-bot · position RE-SHAPE (PURE, no I/O). A DLMM leader continuously ADDS / REMOVES partial liquidity,
 * often on SPECIFIC bins. Rather than matching only the TOTAL size (which lets the per-bin SHAPE drift), we
 * re-shape OUR position so `our per-bin = factor × leader per-bin` (factor caps the total at maxSol), reading
 * both shapes ON-CHAIN at each leader adjustment. Drift-free, self-healing, and EXACT per bin: a selective
 * leader trim/add is mirrored on the precise bins. A per-bin deadband avoids churning on price-driven wiggle.
 */

const BPS_TOTAL = 10_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

export const lamportsToSol = (lamports: bigint): number => Number(lamports) / LAMPORTS_PER_SOL;

/** A bin's SOL-leg amount, keyed by `offset` = bin position relative to the position's LOWER bin (shared leader↔ours
 *  alignment: leader bin `leaderLower+offset` maps to OUR bin `ourLower+offset`, matching the open re-anchor that
 *  aligns leader.lower ↔ our.lower). `reshapeToCalls` reconstructs `binId = baseBin + offset` with baseBin = our lower. */
export interface BinSol {
  offset: number;
  sol: number;
}

/** One per-bin re-shape operation toward the target. `remove.bps` = fraction of OUR CURRENT amount at that bin. */
export type ReshapeOp = { offset: number; action: 'add'; addSol: number } | { offset: number; action: 'remove'; bps: number };

/**
 * SHAPE-EXACT re-sync (PURE). Brings OUR per-bin distribution to `factor × leader per-bin`, where
 * `factor = min(ratio, maxSol/leaderTotal)` caps the TOTAL deployed at `maxSol`. Returns the minimal per-bin
 * add/remove ops (a bin the leader emptied → target 0 → remove 100%; a bin the leader grew → add the diff).
 * `deadbandSol` skips per-bin wiggle. This is what makes a SELECTIVE per-bin leader add/remove copied EXACTLY
 * (the size-only `planResync` only matched the total, letting the shape drift). Inputs aligned by `offset`.
 */
export function planReshape(leaderBins: BinSol[], ourBins: BinSol[], ratio: number, maxSol: number, deadbandSol: number): ReshapeOp[] {
  if (!(ratio > 0)) return [];
  const leaderTotal = leaderBins.reduce((s, b) => s + b.sol, 0);
  if (!(leaderTotal > 0)) return [];
  const factor = Math.min(ratio, maxSol / leaderTotal); // cap the TOTAL deployed SOL at maxSol
  const leaderByOffset = new Map(leaderBins.map((b) => [b.offset, b.sol]));
  const ourByOffset = new Map(ourBins.map((b) => [b.offset, b.sol]));

  const ops: ReshapeOp[] = [];
  for (const offset of new Set([...leaderByOffset.keys(), ...ourByOffset.keys()])) {
    const target = factor * (leaderByOffset.get(offset) ?? 0);
    const cur = ourByOffset.get(offset) ?? 0;
    const delta = target - cur;
    if (Math.abs(delta) <= deadbandSol) continue;
    if (delta > 0) ops.push({ offset, action: 'add', addSol: delta });
    else if (cur > 0) ops.push({ offset, action: 'remove', bps: Math.min(BPS_TOTAL, Math.round((-delta / cur) * BPS_TOTAL)) });
  }
  return ops.sort((a, b) => a.offset - b.offset);
}

/** The SDK calls that realize a re-shape, in OUR absolute binId space. `removes` collapse contiguous bins that
 *  share a bps into one `removeLiquidity(fromBin,toBin,bps)` (a uniform trim → ONE tx); `adds` feed one
 *  `addLiquidityByWeight`. */
export interface ReshapeCalls {
  removes: Array<{ fromBin: number; toBin: number; bps: number }>;
  adds: Array<{ binId: number; addSol: number }>;
}

/** Map per-offset re-shape ops to concrete SDK calls in OUR binId space (`ourBinId = baseBin + offset`, where
 *  `offset` is relative to each position's LOWER bin and `baseBin` = our position's lower — the alignment fixed
 *  at the re-anchored open). Collapses contiguous same-bps removes into ranges to minimize txs. Pure. */
export function reshapeToCalls(ops: ReshapeOp[], baseBin: number): ReshapeCalls {
  const adds = ops.flatMap((o) => (o.action === 'add' ? [{ binId: baseBin + o.offset, addSol: o.addSol }] : []));
  const removeBins = ops
    .flatMap((o) => (o.action === 'remove' ? [{ binId: baseBin + o.offset, bps: o.bps }] : []))
    .sort((a, b) => a.binId - b.binId);

  const removes: ReshapeCalls['removes'] = [];
  for (const r of removeBins) {
    const last = removes.at(-1);
    if (last && last.bps === r.bps && r.binId === last.toBin + 1) last.toBin = r.binId; // extend the contiguous run
    else removes.push({ fromBin: r.binId, toBin: r.binId, bps: r.bps });
  }
  return { removes, adds };
}
