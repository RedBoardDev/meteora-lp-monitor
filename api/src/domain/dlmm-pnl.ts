import { SOL_MINT } from '@binsight/shared';
import type { DlmmLeg, PoolMeta, PositionEconomics } from './dlmm';

/**
 * Pure mark-to-pool PnL for a Meteora DLMM position, fully on-chain (no Meteora API, all history).
 *
 * Each deposit/withdraw/claim leg's non-SOL token amount is valued in SOL at the DLMM geometric bin
 * price of that very transaction (`(1 + binStep/10000)^activeBinId`), which is the historical price
 * at that block — so it never expires (recovers positions Meteora purges). Validated to the lamport
 * against Meteora's own pnl on a real position (GYMtBiHX) — see the unit tests.
 *
 *   PnL = Σ(withdrawals + claimed fees) − Σ(deposits), each leg at its own bin price.
 */

/** Lamports per SOL — the single source of truth, re-used by the application + infra SOL conversions. */
export const LAMPORTS_PER_SOL = 1e9;

/** SOL side of a pool, or null if neither token is SOL (a non-SOL-quote pool — valued in its quote). */
export function solSideOf(mintX: string, mintY: string): 'X' | 'Y' | null {
  if (mintY === SOL_MINT) return 'Y';
  if (mintX === SOL_MINT) return 'X';
  return null;
}

/** price = (1 + binStep/10000)^binId — Y-lamports per X-lamport (the canonical DLMM bin price). */
export function binPriceRaw(binId: number, binStep: number): number {
  return (1 + binStep / 10000) ** binId;
}

/** Value one leg's raw token amounts in SOL via its bin price. */
export function legValueSol(leg: DlmmLeg, meta: PoolMeta): number {
  const price = binPriceRaw(leg.activeBinId, meta.binStep);
  const x = Number(leg.amountX);
  const y = Number(leg.amountY);
  // solSide Y: SOL is token-Y → X×price gives Y-lamports; + Y-lamports.
  // solSide X: SOL is token-X → Y/price gives X-lamports; + X-lamports.
  const lamports = meta.solSide === 'Y' ? x * price + y : x + y / price;
  return lamports / LAMPORTS_PER_SOL;
}

/** Split a position's legs into deposit / withdraw / claimed-fee SOL totals (one source of truth). */
export function positionEconomics(legs: DlmmLeg[], meta: PoolMeta): PositionEconomics {
  let depositSol = 0;
  let withdrawSol = 0;
  let claimedFeesSol = 0;
  for (const leg of legs) {
    const v = legValueSol(leg, meta);
    if (leg.kind === 'deposit') depositSol += v;
    else if (leg.kind === 'withdraw') withdrawSol += v;
    else claimedFeesSol += v; // 'claim'
  }
  return {
    depositSol,
    withdrawSol,
    claimedFeesSol,
    pnlSol: withdrawSol + claimedFeesSol - depositSol,
  };
}

/**
 * Live unrealized SOL PnL of an OPEN position = the "open = snapshot ⊕ legs" model.
 *   uPnL = (realized so far: withdrawals + claimed fees) + (if closed now: live liquidity + unclaimed fees)
 *          − cost basis (deposits)
 * `econ` comes from the leg history (cost basis); `live` from the current on-chain snapshot.
 */
export function openUnrealizedPnlSol(
  econ: Pick<PositionEconomics, 'depositSol' | 'withdrawSol' | 'claimedFeesSol'>,
  live: { sizeSol: number; unclaimedFeesSol: number },
): number {
  return (
    econ.withdrawSol + econ.claimedFeesSol + live.sizeSol + live.unclaimedFeesSol - econ.depositSol
  );
}
