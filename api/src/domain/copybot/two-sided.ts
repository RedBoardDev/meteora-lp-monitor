/**
 * Copy-bot · TWO-SIDED re-anchoring (PURE, no I/O). Extends the SOL-only copy to ALSO replicate the leader's
 * TOKEN leg, so a leader position that holds token (a deliberate two-sided deposit, the always-mixed active bin,
 * or bins the price has crossed) is copied faithfully. Each leg is re-anchored independently (BPS sum 10000 per
 * leg via the tested `reanchorShape`), then merged per bin into `{ solBps, tokenBps }`.
 *
 * The caller (gated by the SOL-only flag) buys `ratio × leaderTokenRaw` of the token (ExactOut) and deposits
 * BOTH legs via the SDK by-weight (`totalXAmount`/`totalYAmount` + per-bin `xBps`/`yBps`). When the token leg is
 * ≤ dust the position is plain one-sided → `twoSided=false` and the caller keeps the fast SOL-only path.
 */
import { type BinSol, type ReshapeOp, planReshape } from './position-adjust';
import { type LeaderBinAmount, type ReanchoredShape, reanchorShape } from './reanchor';

/** Per-bin raw legs of the leader's position: SOL side + the non-SOL token side, keyed by ABSOLUTE bin. */
export interface LeaderBinLegs {
  binId: number;
  solRaw: bigint;
  tokenRaw: bigint;
}

/** A bin's two-sided weights: SOL-leg BPS + token-leg BPS (each a share of its OWN leg total). */
export interface TwoSidedBin {
  binId: number;
  solBps: number;
  tokenBps: number;
}

export interface TwoSidedPlan {
  /** false → token leg ≤ dust (plain one-sided SOL position) → caller uses the existing SOL-only path. */
  twoSided: boolean;
  /** merged per-bin SOL+token BPS, anchored on OUR active bin. */
  weights: TwoSidedBin[];
  leaderSolRaw: bigint;
  /** total token leg of the leader (raw) — the caller buys `ratio × this` (ExactOut) to fund the token side. */
  leaderTokenRaw: bigint;
  lowerBinId: number;
  upperBinId: number;
}

/**
 * Size a two-sided copy: scale BOTH legs by `pct`% of the leader (preserves the leader's SOL:token composition),
 * capping the SOL leg at `maxSolLamports` (the token leg scales down by the SAME cap factor so composition holds).
 * Pure, bigint-exact. NB: must scale each leg by the ratio of LEADER legs — NOT decideEntry's sizeSol, which is
 * the COPY_RATIO of the leader's TOTAL value and would over-deploy the SOL leg.
 */
export function sizeTwoSided(leaderSolRaw: bigint, leaderTokenRaw: bigint, pct: number, maxSolLamports: bigint): { solLamports: bigint; tokenTarget: bigint } {
  let solLamports = (leaderSolRaw * BigInt(pct)) / 100n;
  let tokenTarget = (leaderTokenRaw * BigInt(pct)) / 100n;
  if (maxSolLamports > 0n && solLamports > maxSolLamports) {
    tokenTarget = (tokenTarget * maxSolLamports) / solLamports; // cap the SOL leg, scale token by the same factor
    solLamports = maxSolLamports;
  }
  return { solLamports, tokenTarget };
}

/**
 * Plan a TWO-SIDED re-shape of an existing position (PURE). `removeLiquidity(bps)` pulls BOTH legs of a bin at
 * once, so a SOL-leg remove already trims the token in any bin that ALSO carries SOL (the active bin + the SOL
 * range). But a position's PURE-TOKEN bins (above the active bin, no SOL leg) are invisible to the SOL-leg plan —
 * on a leader shrink they would never be trimmed and the copy would drift token-heavy. So we ALSO compute the
 * token leg's REMOVE ops and merge in those on bins NOT already covered by a SOL-leg remove (avoiding a double
 * trim on mixed bins). Token ADD ops stay separate (an add can be per-leg → the deficit token to BUY + deposit).
 * Reuses the tested `planReshape` per leg (unit-agnostic: pass each leg's per-bin amount + a per-leg deadband).
 */
export function planTwoSidedReshape(
  leaderSol: BinSol[],
  ourSol: BinSol[],
  leaderToken: BinSol[],
  ourToken: BinSol[],
  ratio: number,
  maxSol: number,
  solDeadband: number,
  tokenDeadband: number,
): { ops: ReshapeOp[]; tokenAddOps: Extract<ReshapeOp, { action: 'add' }>[] } {
  // ONE shared cap factor for BOTH legs (mirrors sizeTwoSided's same-factor semantics): when the SOL cap
  // binds, the token leg must scale by the SAME factor — else the copy buys token toward an UNCAPPED
  // `ratio × leaderToken`, ratchets past maxTradeSizeSol, and re-detects a deficit on every event. The cap is
  // folded into `factor` here, so both planReshape calls take `factor` as ratio with maxSol = ∞.
  const leaderSolTotal = leaderSol.reduce((s, b) => s + b.sol, 0);
  const factor = leaderSolTotal > 0 ? Math.min(ratio, maxSol / leaderSolTotal) : ratio;
  const solOps = planReshape(leaderSol, ourSol, factor, Number.POSITIVE_INFINITY, solDeadband);
  const tokenOps = planReshape(leaderToken, ourToken, factor, Number.POSITIVE_INFINITY, tokenDeadband);
  const tokenAddOps = tokenOps.filter((o): o is Extract<ReshapeOp, { action: 'add' }> => o.action === 'add');
  // Token REMOVE ops only on bins a SOL-leg remove doesn't already trim (pure-token bins) — else we'd double-trim.
  const solRemoveOffsets = new Set(solOps.filter((o) => o.action === 'remove').map((o) => o.offset));
  const tokenRemoveOps = tokenOps.filter((o) => o.action === 'remove' && !solRemoveOffsets.has(o.offset));
  return { ops: [...solOps, ...tokenRemoveOps], tokenAddOps };
}

/** Re-anchor ONE leg, or null when the leg carries no liquidity (avoids reanchorShape throwing on an empty leg). */
function reanchorLeg(legs: LeaderBinLegs[], pick: (b: LeaderBinLegs) => bigint, leaderActive: number, ourActive: number): ReanchoredShape | null {
  const perBin: LeaderBinAmount[] = legs.map((b) => ({ binId: b.binId, amount: pick(b) }));
  if (perBin.every((b) => b.amount <= 0n)) return null;
  return reanchorShape(leaderActive, ourActive, perBin);
}

/**
 * Plan a two-sided re-anchored copy. Pure. Handles all cases: plain SOL-only (token ≤ dust → twoSided=false),
 * genuine two-sided (both legs), and fully-crossed token-only (no SOL leg). Throws only on an empty position.
 */
export function planTwoSided(legs: LeaderBinLegs[], leaderActiveBinId: number, ourActiveBinId: number, dustTokenRaw: bigint): TwoSidedPlan {
  const leaderSolRaw = legs.reduce((s, b) => s + b.solRaw, 0n);
  const leaderTokenRaw = legs.reduce((s, b) => s + b.tokenRaw, 0n);
  const solShape = reanchorLeg(legs, (b) => b.solRaw, leaderActiveBinId, ourActiveBinId);
  const twoSided = leaderTokenRaw > dustTokenRaw;

  const byBin = new Map<number, TwoSidedBin>();
  if (solShape) for (const w of solShape.weights) byBin.set(w.binId, { binId: w.binId, solBps: w.bps, tokenBps: 0 });

  if (twoSided) {
    const tokenShape = reanchorLeg(legs, (b) => b.tokenRaw, leaderActiveBinId, ourActiveBinId);
    if (tokenShape) {
      for (const w of tokenShape.weights) {
        const e = byBin.get(w.binId);
        if (e) e.tokenBps = w.bps;
        else byBin.set(w.binId, { binId: w.binId, solBps: 0, tokenBps: w.bps });
      }
    }
  }

  const weights = [...byBin.values()].sort((a, b) => a.binId - b.binId);
  if (weights.length === 0) throw new Error('planTwoSided: empty position (no SOL and no token liquidity)');
  const binIds = weights.map((w) => w.binId);
  return { twoSided, weights, leaderSolRaw, leaderTokenRaw, lowerBinId: Math.min(...binIds), upperBinId: Math.max(...binIds) };
}
