import {
  type ClosedPosition,
  type OpenPosition,
  type RangeStatus,
  SOL_MINT,
  type StrategyFamily,
} from '@binsight/shared';
import type { OnchainPositionValue, OnchainValued } from '@/domain/dlmm';
import { binPriceRaw, openUnrealizedPnlSol } from '@/domain/dlmm-pnl';
import type { TokenMeta } from '@/domain/ports';
import { isOutOfRange, resolveRangeStatus } from '@/domain/position';
import type { PositionPnl } from './dlmm-position-pnl';

/**
 * The on-chain replacement for the Meteora-sourced position rows. `buildPositionRows` turns the
 * decoded-leg projection (`PositionPnl`, the cost basis + realized economics for EVERY position) plus
 * the current on-chain snapshot (live value for the positions still OPEN) into the exact `OpenPosition`
 * / `ClosedPosition` shapes the repository already persists — so the freeze/set-diff write path is reused
 * unchanged, only the SOURCE of the rows changes (Meteora → chain). Pure: no I/O, fully unit-testable.
 *
 *   open   = snapshot (live size/fees/range) ⊕ legs (cost basis → uPnL) ⊕ token metadata
 *   closed = legs projection (realized mark-to-pool) ⊕ token metadata
 *   status = membership in the live snapshot (in snapshot → open, else → closed)
 */

/** Live per-position value derived from the on-chain snapshot (the open set + current valuation). */
export interface LivePositionValue {
  sizeSol: number;
  unclaimedFeesSol: number;
  minPrice: number;
  maxPrice: number;
  poolPrice: number | null;
  rangeStatus: RangeStatus;
}

/** mint → display metadata. Must always return a usable symbol (fallback to a short mint), never empty. */
export type TokenMetaResolver = (mint: string) => TokenMeta;

export interface BuildPositionRowsInput {
  wallet: string;
  /** all positions ever touched (open + closed), with cost basis + realized economics, from the legs. */
  projection: PositionPnl[];
  /** live value for the positions currently OPEN — membership here decides open vs closed. */
  live: Map<string, LivePositionValue>;
  meta: TokenMetaResolver;
  strategy: ReadonlyMap<string, StrategyFamily | null>;
  /** previous `outOfRangeSince` per open position, so the OOR clock isn't reset every sync. */
  priorOorSince: Map<string, number | null>;
  /** wall-clock for `updatedAt` / a fresh OOR start. */
  now: number;
}

export function buildPositionRows(input: BuildPositionRowsInput): {
  open: OpenPosition[];
  closed: ClosedPosition[];
} {
  const open: OpenPosition[] = [];
  const closed: ClosedPosition[] = [];

  for (const p of input.projection) {
    const baseMeta = input.meta(p.tokenMint);
    // SOL pool → quote is SOL; non-SOL-quote pool → we don't reconstruct its quote mint here (flagged).
    const quoteMeta = p.solDenominated ? input.meta(SOL_MINT) : { symbol: '?' };
    const tokenX = baseMeta.symbol;
    const tokenY = quoteMeta.symbol;
    const strategy = input.strategy.get(p.position) ?? null;
    const liveVal = input.live.get(p.position);

    if (liveVal) {
      // OPEN: snapshot ⊕ legs
      const pnlSol = openUnrealizedPnlSol(p, liveVal);
      const pnlPctSol = p.depositSol > 0 ? (pnlSol / p.depositSol) * 100 : 0;
      const prior = input.priorOorSince.get(p.position) ?? null;
      const outOfRangeSince = isOutOfRange(liveVal.rangeStatus) ? (prior ?? input.now) : null;
      open.push({
        positionAddress: p.position,
        wallet: input.wallet,
        poolAddress: p.pool,
        tokenX,
        tokenY,
        tokenXMint: p.tokenMint,
        tokenXIcon: baseMeta.icon,
        tokenYIcon: quoteMeta.icon,
        strategy,
        sizeSol: liveVal.sizeSol,
        pnlSol,
        pnlPctSol,
        claimedFeesSol: p.claimedFeesSol,
        unclaimedFeesSol: liveVal.unclaimedFeesSol,
        rangeStatus: liveVal.rangeStatus,
        minPrice: liveVal.minPrice,
        maxPrice: liveVal.maxPrice,
        poolPrice: liveVal.poolPrice,
        outOfRangeSince,
        openedAt: p.openedAt || null,
        updatedAt: input.now,
      });
    } else {
      // CLOSED: realized mark-to-pool from the legs
      const pnlPctSol = p.depositSol > 0 ? (p.pnlSol / p.depositSol) * 100 : 0;
      closed.push({
        positionAddress: p.position,
        wallet: input.wallet,
        poolAddress: p.pool,
        tokenX,
        tokenY,
        tokenXMint: p.tokenMint,
        tokenXIcon: baseMeta.icon,
        tokenYIcon: quoteMeta.icon,
        strategy,
        pnlSol: p.pnlSol,
        pnlPctSol,
        feesSol: p.claimedFeesSol,
        depositSol: p.depositSol,
        withdrawSol: p.withdrawSol,
        openedAt: p.openedAt || null,
        closedAt: p.closedAt || null,
        durationSeconds: p.durationSeconds || null,
        pnlSource: 'pool',
      });
    }
  }

  return { open, closed };
}

/**
 * Meteora SDK price convention: pricePerLamport × 10^(decimalsX − decimalsY). Reproducing it on-chain
 * (we have the decimals in the snapshot) matches the datapi's minPrice/maxPrice/poolActivePrice exactly,
 * so the range bar renders identically after the cutover.
 */
function humanPrice(binId: number, binStep: number, decimalsX: number, decimalsY: number): number {
  return binPriceRaw(binId, binStep) * 10 ** (decimalsX - decimalsY);
}

/**
 * Derive the live per-position values (size / unclaimed fees / range prices / range status) from the
 * on-chain snapshot. Membership of the returned map IS the open set the sync uses to split open vs closed.
 */
export function snapshotToLive(
  positions: OnchainPositionValue[],
  valued: Pick<OnchainValued, 'sizeSolByPosition' | 'feeSolByPosition'>,
): Map<string, LivePositionValue> {
  const out = new Map<string, LivePositionValue>();
  for (const p of positions) {
    const minPrice = humanPrice(p.lowerBinId, p.binStep, p.decimalsX, p.decimalsY);
    const maxPrice = humanPrice(p.upperBinId, p.binStep, p.decimalsX, p.decimalsY);
    const poolPrice = humanPrice(p.activeId, p.binStep, p.decimalsX, p.decimalsY);
    out.set(p.positionAddress, {
      sizeSol: valued.sizeSolByPosition.get(p.positionAddress) ?? 0,
      unclaimedFeesSol: valued.feeSolByPosition.get(p.positionAddress) ?? 0,
      minPrice,
      maxPrice,
      poolPrice,
      rangeStatus: resolveRangeStatus(poolPrice, minPrice, maxPrice),
    });
  }
  return out;
}
