import type { PositionEconomics, StoredLeg } from '@/domain/dlmm';
import { positionEconomics } from '@/domain/dlmm-pnl';
import type { LegRepository, PositionRepository } from '@/domain/ports';

/** Per-wallet outcome of a legs-recompute pass — the numbers the backfill logs (no-miss accounting). */
export interface RepairResult {
  /** closed positions considered (every closed row of the wallet). */
  scanned: number;
  /** rows whose stored economics actually differed from the legs recompute and were rewritten. */
  corrected: number;
  /** closed positions whose pool meta is absent from dlmm_pools (can't value → left untouched). */
  skippedNoPoolMeta: number;
  /** closed positions in a non-SOL-quote pool (SOL economics are legitimately 0 → left untouched). */
  skippedNonSol: number;
  /** closed positions with no ingested legs at all (nothing to recompute → left untouched). */
  skippedNoLegs: number;
}

const EMPTY: RepairResult = {
  scanned: 0,
  corrected: 0,
  skippedNoPoolMeta: 0,
  skippedNonSol: 0,
  skippedNoLegs: 0,
};

/** True when any of the four legs-derived figures changed. Exact comparison: the canonical stored value
 *  is itself produced by positionEconomics over the same legsByWallet ordering, so a correctly-written
 *  row matches to the bit and is skipped (no-op write avoided + idempotent on a second run). */
function differs(a: PositionEconomics, b: PositionEconomics): boolean {
  return (
    a.depositSol !== b.depositSol ||
    a.withdrawSol !== b.withdrawSol ||
    a.claimedFeesSol !== b.claimedFeesSol ||
    a.pnlSol !== b.pnlSol
  );
}

/**
 * Recompute every CLOSED position's legs-derived economics (deposit/withdraw/claimed-fees/pnl in SOL)
 * for one wallet straight from its ingested on-chain legs + DB-cached pool meta, and rewrite only the
 * rows that actually changed — bypassing the position store's settle-freeze so stale old closes are
 * corrected. Fully DB-only: no Solana RPC / Helius. Pool meta comes from dlmm_pools (LegRepository);
 * a position whose pool meta is missing is SKIPPED (counted), never guessed. market_pnl_sol, status
 * and timestamps are never touched; open positions are never considered.
 */
export async function repairClosedEconomicsFromLegs(
  wallet: string,
  deps: {
    legRepo: Pick<LegRepository, 'legsByWallet' | 'getPoolMetas'>;
    positionRepo: Pick<
      PositionRepository,
      'closedEconomicsForWallet' | 'repairClosedEconomicsMany'
    >;
  },
): Promise<RepairResult> {
  const { legRepo, positionRepo } = deps;
  const stored = await positionRepo.closedEconomicsForWallet(wallet);
  if (stored.size === 0) return { ...EMPTY };

  // Group only the CLOSED positions' legs (ignore legs of open positions — out of scope + never written).
  const byPos = new Map<string, StoredLeg[]>();
  for (const leg of await legRepo.legsByWallet(wallet)) {
    if (!stored.has(leg.position)) continue;
    const arr = byPos.get(leg.position);
    if (arr) arr.push(leg);
    else byPos.set(leg.position, [leg]);
  }

  const pools = [...new Set([...byPos.values()].map((legs) => legs[0]!.lbPair))];
  const poolMetas = await legRepo.getPoolMetas(pools);

  const updates = new Map<string, PositionEconomics>();
  const result: RepairResult = { ...EMPTY, scanned: stored.size };
  for (const [address, prev] of stored) {
    const legs = byPos.get(address);
    if (!legs || legs.length === 0) {
      result.skippedNoLegs++;
      continue;
    }
    const meta = poolMetas.get(legs[0]!.lbPair);
    if (!meta) {
      result.skippedNoPoolMeta++;
      continue;
    }
    if (!meta.solSide) {
      // Non-SOL-quote pool: a SOL valuation needs a quote/SOL series we don't reconstruct here, so the
      // live path stores zeroed SOL economics — recomputing via a bin price would be wrong. Leave as-is.
      result.skippedNonSol++;
      continue;
    }
    const econ = positionEconomics(legs, { binStep: meta.binStep, solSide: meta.solSide });
    const next: PositionEconomics = {
      depositSol: econ.depositSol,
      withdrawSol: econ.withdrawSol,
      claimedFeesSol: econ.claimedFeesSol,
      pnlSol: econ.pnlSol,
    };
    if (differs(prev, next)) updates.set(address, next);
  }

  await positionRepo.repairClosedEconomicsMany(updates);
  result.corrected = updates.size;
  return result;
}
