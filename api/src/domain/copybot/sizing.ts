/**
 * Copy-bot · P2.2 — SIZE (the heart of the decision). PURE sizing brick, deterministic, no I/O.
 *
 * Rule (spec 06 §1.1/§1.8, 04 §2.1, DECISIONS Round 1/Round 5):
 *   desiredSize = ratio% × leaderSize, capped by maxTradeSizeSol
 *   empty ratio (null) ⇒ FIXED-SIZE mode: always deploy maxTradeSizeSol (independent of leader size)
 *   ratio > 100% allowed · cap applied LAST
 *   floor minPositionSizeSol (0.05): a target below it ⇒ skip (never dust)
 *   insufficient balance ⇒ onInsufficient: 'skip' (default) | 'reduceToFit' (open with available − solReserveSol),
 *     then re-checked against the floor (below it ⇒ skip anyway)
 *
 * `leaderSizeSol` (input) = SOL value of the leader OPEN's deposit legs (spec 05 §3) — it's the `depositSol`
 * of the detected event. The base for a PARTIAL withdraw (current size) will come with the position tracker (P2.x).
 * We assume finite inputs >= 0 (the pipeline provides `depositSol`, already >= 0).
 */
import type { BrickMeta } from './bricks';

export interface SizingConfig {
  /** Ratio applied to the leader size, in %. `null` = fixed-size mode (always deploy `maxTradeSizeSol`). */
  tradeRatioPct: number | null;
  /** Hard cap on a copy's size (always applied last). */
  maxTradeSizeSol: number;
  /** Anti-dust floor: a desired size below it ⇒ skip. (Decided = 0.05.) */
  minPositionSizeSol: number;
  /** Reserved gas buffer, subtracted from the available balance under `reduceToFit`. */
  solReserveSol: number;
  /** Behavior when the balance does not cover the desired size. */
  onInsufficient: 'skip' | 'reduceToFit';
}

/** State (paper-simulated) of the copier wallet, as seen by the decision. */
export interface FollowerState {
  /** Copier's free SOL balance. */
  availableBalanceSol: number;
}

export type SkipReason = 'below_min_floor' | 'insufficient_balance';

export type SizingDecision =
  | { action: 'open'; sizeSol: number; reduced: boolean }
  | { action: 'skip'; reason: SkipReason };

/** Computes the copy size (or a motivated skip) for a leader OPEN. Pure — no I/O, no key. */
export function computeCopySize(
  config: SizingConfig,
  leaderSizeSol: number,
  follower: FollowerState,
): SizingDecision {
  // 1) Desired size: fixed-size mode (empty ratio) or capped ratio.
  const desired =
    config.tradeRatioPct == null
      ? config.maxTradeSizeSol
      : Math.min((config.tradeRatioPct / 100) * leaderSizeSol, config.maxTradeSizeSol);

  // 2) Floor BEFORE balance: a target already under the floor = copy too small, abstain (no dust).
  if (desired < config.minPositionSizeSol) return { action: 'skip', reason: 'below_min_floor' };

  // 3) Balance check (gas reserve set aside).
  const available = follower.availableBalanceSol - config.solReserveSol;
  if (desired <= available) return { action: 'open', sizeSol: desired, reduced: false };

  // 4) Insufficient balance.
  if (config.onInsufficient === 'skip') return { action: 'skip', reason: 'insufficient_balance' };
  // reduceToFit: open with the available amount, but re-checked against the floor.
  if (available < config.minPositionSizeSol) return { action: 'skip', reason: 'insufficient_balance' };
  return { action: 'open', sizeSol: available, reduced: true };
}

/** Interface of the "sizing" family: produces a size decision from the leader size + the copier state. */
export interface SizingBrick extends BrickMeta {
  readonly family: 'sizing';
  size(config: SizingConfig, leaderSizeSol: number, follower: FollowerState): SizingDecision;
}

/** The default/core sizing brick: capped ratio% (`coreRatioMax` mode). Per-leader scoped tuning. */
export const coreRatioMaxSizingBrick: SizingBrick = {
  id: 'coreRatioMax',
  family: 'sizing',
  scope: 'per-leader',
  speedClass: 'instant',
  defaultEnabled: true,
  size: computeCopySize,
};
