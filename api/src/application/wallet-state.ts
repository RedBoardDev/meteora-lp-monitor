import type { OpenPosition, PortfolioTotals, WalletState } from '@binsight/shared';
import type { OnchainValued } from '@/domain/dlmm';
import { isOutOfRange } from '@/domain/position';

// Above this cross-chunk slot skew (large wallets, >100 getMultipleAccounts keys) the total is read
// across a few slots rather than one — surface it as "syncing" instead of a possibly-inconsistent number.
const SYNCING_SKEW_SLOTS = 25;

/** Fallback totals from Meteora positions + a plain idle figure (used before the first on-chain snapshot). */
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

/** Override each position's value/fees with the slot-consistent on-chain numbers (when present). */
function applyOnchain(positions: OpenPosition[], onchain: OnchainValued): OpenPosition[] {
  return positions.map((p) => {
    const size = onchain.sizeSolByPosition.get(p.positionAddress);
    if (size == null) return p;
    const fee = onchain.feeSolByPosition.get(p.positionAddress);
    return { ...p, sizeSol: size, unclaimedFeesSol: fee ?? p.unclaimedFeesSol };
  });
}

/**
 * WalletState with an authoritative, slot-consistent total. PnL / claimed fees / range counts come
 * from the Meteora-driven positions (deposit-basis data on-chain can't supply); TVL / idle / unclaimed
 * fees / walletTotal come from the on-chain snapshot — which makes double-counting structurally impossible.
 * Falls back to `buildTotals` until the first snapshot lands.
 */
export function buildWalletState(
  scope: string,
  positions: OpenPosition[],
  onchain: OnchainValued | null,
): WalletState {
  if (!onchain) {
    const sorted = [...positions].sort((a, b) => b.pnlSol - a.pnlSol);
    return {
      scope,
      totals: buildTotals(sorted, 0),
      openPositions: sorted,
      asOfSlot: null,
      freshness: 'syncing',
      updatedAt: Date.now(),
    };
  }
  const sorted = applyOnchain(positions, onchain).sort((a, b) => b.pnlSol - a.pnlSol);
  const base = buildTotals(sorted, onchain.idleSol);
  const totals: PortfolioTotals = {
    ...base,
    tvlSol: onchain.tvlSol,
    unclaimedFeesSol: onchain.unclaimedFeesSol,
    feesSol: base.claimedFeesSol + onchain.unclaimedFeesSol,
    walletTotalSol: onchain.walletTotalSol,
  };
  return {
    scope,
    totals,
    openPositions: sorted,
    asOfSlot: onchain.slot,
    // An incomplete valuation (missing price, unfetched bin-array, unknown decimals) is under/over-stated
    // → report 'syncing' so the UI signals it AND the Net Worth recorder skips persisting a wrong point.
    freshness: !onchain.complete || onchain.slotSkew > SYNCING_SKEW_SLOTS ? 'syncing' : 'fresh',
    updatedAt: Date.now(),
  };
}

/** Merge several wallets' on-chain valuations into one (for the aggregated "all" scope). */
export function combineOnchain(present: OnchainValued[]): OnchainValued | null {
  if (present.length === 0) return null;
  const sizeBy = new Map<string, number>();
  const feeBy = new Map<string, number>();
  let tvlSol = 0;
  let idleSol = 0;
  let unclaimedFeesSol = 0;
  let lockedRentSol = 0;
  let walletTotalSol = 0;
  let positionCount = 0;
  let slot = 0;
  let slotSkew = 0;
  for (const v of present) {
    tvlSol += v.tvlSol;
    idleSol += v.idleSol;
    unclaimedFeesSol += v.unclaimedFeesSol;
    lockedRentSol += v.lockedRentSol;
    walletTotalSol += v.walletTotalSol;
    positionCount += v.positionCount;
    slot = Math.max(slot, v.slot);
    slotSkew = Math.max(slotSkew, v.slotSkew);
    for (const [k, s] of v.sizeSolByPosition) sizeBy.set(k, s);
    for (const [k, f] of v.feeSolByPosition) feeBy.set(k, f);
  }
  return {
    slot,
    slotSkew,
    tvlSol,
    idleSol,
    unclaimedFeesSol,
    lockedRentSol,
    walletTotalSol,
    positionCount,
    // The aggregate is complete only if every contributing wallet's valuation was complete.
    complete: present.every((v) => v.complete),
    sizeSolByPosition: sizeBy,
    feeSolByPosition: feeBy,
  };
}
