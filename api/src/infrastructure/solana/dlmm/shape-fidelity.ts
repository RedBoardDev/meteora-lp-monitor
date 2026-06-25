/**
 * Copy-bot · position-copy FIDELITY comparison (PURE, no I/O). Given the leader's and the copy's per-bin legs,
 * computes how faithfully the copy reproduces the leader — by ECONOMIC value (SOL + token-valued-in-SOL, the
 * arb-invariant metric) AND by the SOL leg alone (what a SOL-only copy actually controls). Both are normalized
 * per-bin distributions keyed by offset-from-active, so the max per-bin diff is shape fidelity; the absolute
 * totals give the size ratio. Used by the on-chain test harness (assertions) and the diag script (printing).
 *
 * Bin valuation: the raw bin price P = (1 + binStep/10000)^binId is Y-lamports per X-lamport, so a bin's value
 * in SOL-lamports is `y + x·P` (SOL = Y) or `x + y/P` (SOL = X) — NO decimal factor (P already acts on raw amounts).
 */

export interface BinLegs {
  binId: number;
  x: bigint;
  y: bigint;
}

export interface PositionShape {
  activeBinId: number;
  perBin: BinLegs[];
}

export interface FidelityResult {
  /** max per-bin difference of the normalized ECONOMIC distribution (SOL + token), in percentage points. */
  maxEconDiffPct: number;
  /** max per-bin difference of the normalized SOL-LEG distribution — what a SOL-side copy actually reproduces. */
  maxSolLegDiffPct: number;
  /** absolute total economic value (SOL) of each side, and the copy/leader ratio (≈ COPY_RATIO when faithful). */
  totalLeaderSol: number;
  totalCopySol: number;
  totalRatio: number;
  /** copy/leader ratio of the SOL LEG only (lamports) — what a SOL-side copy actually deploys; ≈ COPY_RATIO even
   *  when the leader also holds a token leg the one-sided copy doesn't replicate (so it's the right one-sided check). */
  solLegRatio: number;
  /** copy/leader ratio of the TOKEN LEG only (raw token units) — the DIRECT test of two-sided replication: ≈ COPY_RATIO
   *  when the token leg is faithfully copied, exactly 0 for a one-sided copy (which holds no token). Unlike the econ
   *  ratio (dominated by the larger SOL leg) this cleanly separates two-sided from one-sided regardless of leg sizes. */
  tokenLegRatio: number;
  /** same number of bins on both sides. */
  sameBinCount: boolean;
  leaderBinCount: number;
  copyBinCount: number;
}

const binPrice = (binId: number, binStep: number): number => (1 + binStep / 10000) ** binId;

/** A bin's full economic value in SOL-lamports (both legs). */
function econLamports(b: BinLegs, solSide: 'X' | 'Y', binStep: number): number {
  const p = binPrice(b.binId, binStep);
  return solSide === 'Y' ? Number(b.y) + Number(b.x) * p : Number(b.x) + Number(b.y) / p;
}

/** A bin's SOL-leg only, in lamports. */
const solLegLamports = (b: BinLegs, solSide: 'X' | 'Y'): number => Number(solSide === 'Y' ? b.y : b.x);

/** A bin's TOKEN-leg only, in raw token units (the non-SOL side). */
const tokenLegRaw = (b: BinLegs, solSide: 'X' | 'Y'): number => Number(solSide === 'Y' ? b.x : b.y);

/**
 * Map a shape to per-offset values via `valueOf`, keyed by offset-from-LOWER (binId − min binId of the shape).
 * This is SHIFT-INVARIANT: the copy re-anchors the leader's shape by a constant bin shift (`ourActive −
 * leaderActive` at open, in reanchorShape), so `copy.binId − copy.lower == leader.binId − leader.lower` for
 * corresponding liquidity. Keying by offset-from-lower cancels that shift exactly — whereas offset-from-ACTIVE
 * depends on the per-read pool active bin (which can differ by a bin between the leader's and copy's reads, or
 * carry a deliberate open-shift), misaligning a sharp shape (e.g. a one-bin spike) and reporting a false divergence.
 */
function byOffset(shape: PositionShape, valueOf: (b: BinLegs) => number): Map<number, number> {
  const lowerBinId = Math.min(...shape.perBin.map((b) => b.binId));
  const out = new Map<number, number>();
  for (const b of shape.perBin) out.set(b.binId - lowerBinId, valueOf(b));
  return out;
}

const total = (m: Map<number, number>): number => [...m.values()].reduce((s, v) => s + v, 0);

function normalize(m: Map<number, number>): Map<number, number> {
  const t = total(m) || 1;
  return new Map([...m].map(([k, v]) => [k, v / t]));
}

/** Max bin-offset shift tried when aligning the two distributions (see maxDiffPct). The copy is the leader's shape
 *  rigidly shifted by a constant (the open re-anchor); a read-time active-bin difference or an edge-bin BPS-rounding
 *  drop can offset the two frames by a bin or two. */
const MAX_ALIGN_SHIFT = 2;

/**
 * Max absolute difference (percentage points) between two normalized distributions, minimized over a small rigid
 * SHIFT of `b` (±MAX_ALIGN_SHIFT bins). Because the copy is the leader's shape shifted by a constant, the right
 * comparison is shift-invariant; searching the best shift absorbs the residual frame offset (active-bin read noise,
 * an edge-bin rounding drop). Crucially this forgives ONLY a rigid offset — a real shape DISTORTION (mis-distributed
 * liquidity, a sizing/re-anchor regression) survives every shift, so it's still caught.
 */
function maxDiffPct(a: Map<number, number>, b: Map<number, number>): number {
  let best = Number.POSITIVE_INFINITY;
  for (let k = -MAX_ALIGN_SHIFT; k <= MAX_ALIGN_SHIFT; k++) {
    let max = 0;
    for (const off of new Set([...a.keys(), ...[...b.keys()].map((o) => o + k)])) {
      max = Math.max(max, Math.abs((a.get(off) ?? 0) - (b.get(off - k) ?? 0)) * 100);
    }
    best = Math.min(best, max);
  }
  return best;
}

/** Compare the copy's fidelity to the leader. Pure. */
export function compareFidelity(leader: PositionShape, copy: PositionShape, solSide: 'X' | 'Y', binStep: number): FidelityResult {
  const lEcon = byOffset(leader, (b) => econLamports(b, solSide, binStep));
  const cEcon = byOffset(copy, (b) => econLamports(b, solSide, binStep));
  const lSol = byOffset(leader, (b) => solLegLamports(b, solSide));
  const cSol = byOffset(copy, (b) => solLegLamports(b, solSide));
  const lTok = byOffset(leader, (b) => tokenLegRaw(b, solSide));
  const cTok = byOffset(copy, (b) => tokenLegRaw(b, solSide));
  const totalLeaderSol = total(lEcon) / 1e9;
  const totalCopySol = total(cEcon) / 1e9;
  const leaderSolLeg = total(lSol);
  const leaderTokenLeg = total(lTok);
  return {
    maxEconDiffPct: maxDiffPct(normalize(lEcon), normalize(cEcon)),
    maxSolLegDiffPct: maxDiffPct(normalize(lSol), normalize(cSol)),
    totalLeaderSol,
    totalCopySol,
    totalRatio: totalLeaderSol > 0 ? totalCopySol / totalLeaderSol : 0,
    solLegRatio: leaderSolLeg > 0 ? total(cSol) / leaderSolLeg : 0,
    tokenLegRatio: leaderTokenLeg > 0 ? total(cTok) / leaderTokenLeg : 0,
    sameBinCount: leader.perBin.length === copy.perBin.length,
    leaderBinCount: leader.perBin.length,
    copyBinCount: copy.perBin.length,
  };
}
