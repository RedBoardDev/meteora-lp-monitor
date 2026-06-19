import { type ClosedPosition, SOL_MINT } from '@binsight/shared';
import type { ResidualSell } from '@/domain/dlmm';

export type { ResidualSell };

/** Per closed position: how much of its residual was really sold (and for how much), what's still held. */
export interface RealizedResidual {
  positionAddress: string;
  /** SOL really received for the SOLD part of the residual (on-chain fact). */
  soldProceeds: number;
  /** residual tokens accounted as sold. */
  soldAmount: number;
  /** residual tokens still unsold — caller values these at the CURRENT market (Jupiter quote). */
  heldAmount: number;
  mint: string;
  /** soldAmount / residualAmount — 1 = fully realized, 0 = entirely held. */
  fillFraction: number;
}

/** Sells start counting from `closeAt - PRE_CLOSE_SLACK` (close + dump can straddle the same second). */
const PRE_CLOSE_SLACK_SEC = 60;
/**
 * Sells later than `closeAt + DEFAULT_WINDOW` are treated as a separate decision, not this exit.
 * Empirically (window sweep on real residual exits) the dumped fraction SATURATES at ~3 days — 3d, 7d
 * and 30d all match, so 3 days captures every real dump while a longer window only risks attributing
 * an unrelated later re-trade of the same mint. The old 30-min window missed ~half the dumps (they
 * landed minutes-to-days after close), under-/over-marking the residual; 3 days fixes that.
 */
const DEFAULT_WINDOW_SEC = 3 * 86_400;

/**
 * FIFO lot accounting for closed-position residuals. Each position's leftover non-SOL token is
 * matched to the wallet's REAL on-chain sells of that mint: positions are processed oldest-close
 * first, each consuming the oldest not-yet-consumed post-close sells of its mint up to its residual
 * amount. This splits a residual sold in several clips AND several positions' residuals dumped in
 * one swap, with no double-counting (a sell's tokens are consumed once). Pure & deterministic.
 *
 * Returns, per position, the SOL really received for the sold part and the still-held remainder.
 * The held remainder carries no realized value — the caller prices it at the current market.
 */
export function reconstructRealized(
  positions: Pick<
    ClosedPosition,
    'positionAddress' | 'residualMint' | 'residualAmount' | 'residualMarkSol' | 'closedAt'
  >[],
  sells: ResidualSell[],
  opts: { windowSec?: number } = {},
): RealizedResidual[] {
  const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC;

  // Mutable per-mint sell ledger (oldest first), each with a remaining token + SOL balance.
  const ledger = new Map<string, { ts: number; remTok: number; remSol: number }[]>();
  for (const s of sells) {
    if (!s.mint || s.tokenAmount <= 0 || s.solReceived <= 0) continue;
    const arr = ledger.get(s.mint) ?? [];
    arr.push({ ts: s.ts, remTok: s.tokenAmount, remSol: s.solReceived });
    ledger.set(s.mint, arr);
  }
  for (const arr of ledger.values()) arr.sort((a, b) => a.ts - b.ts);

  const residualPositions = positions
    .filter(
      (p) =>
        (p.residualMarkSol ?? 0) > 0 &&
        (p.residualAmount ?? 0) > 0 &&
        p.residualMint &&
        (p.closedAt ?? 0) > 0, // no closedAt → window math collapses to "held"; skip (keep pool-spot)
    )
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));

  const out: RealizedResidual[] = [];
  for (const p of residualPositions) {
    const mint = p.residualMint as string;
    const residAmount = p.residualAmount as number;
    const closeAt = (p.closedAt ?? 0) / 1000; // closedAt is ms
    const sellsForMint = ledger.get(mint) ?? [];

    let needTok = residAmount;
    let soldProceeds = 0;
    let soldAmount = 0;
    for (const lot of sellsForMint) {
      if (needTok <= 1e-9) break;
      if (lot.remTok <= 1e-9) continue;
      if (lot.ts < closeAt - PRE_CLOSE_SLACK_SEC) continue; // pre-close sell: not this exit
      if (lot.ts > closeAt + windowSec) break; // ledger is time-sorted → nothing later qualifies
      const take = Math.min(needTok, lot.remTok);
      const solShare = (lot.remSol * take) / lot.remTok;
      lot.remTok -= take;
      lot.remSol -= solShare;
      needTok -= take;
      soldProceeds += solShare;
      soldAmount += take;
    }

    out.push({
      positionAddress: p.positionAddress,
      soldProceeds,
      soldAmount,
      heldAmount: Math.max(0, residAmount - soldAmount),
      mint,
      fillFraction: residAmount > 0 ? soldAmount / residAmount : 0,
    });
  }
  return out;
}

/**
 * Real-cash closed PnL for one position: replace Meteora's pool-spot residual mark with the SOL
 * really received (sold part) plus the current market value of any still-held remainder.
 *   pnl_real = pnlSol − residualMarkSol + soldProceeds + heldValue
 * `heldValue` is the caller's current Jupiter quote for `heldAmount` (0 if none/no route).
 */
export function realizedPnl(
  closed: ClosedPosition,
  r: RealizedResidual,
  heldValue: number,
): number {
  return closed.pnlSol - (closed.residualMarkSol ?? 0) + r.soldProceeds + heldValue;
}

/**
 * Fully on-chain realized PnL (no Meteora) for a position recovered from its chain txs: the wallet's
 * net SOL across the position (`solLegSol`) plus the real cash from selling the residual it took out.
 *   pnl = solLegSol + soldProceeds + heldValue
 * A still-held remainder (`heldValue`) is the caller's current worth (0 for a dead/worthless token).
 */
export function onchainRealizedPnl(
  solLegSol: number,
  r: RealizedResidual,
  heldValue: number,
): number {
  return solLegSol + r.soldProceeds + heldValue;
}

/** One decoded DLMM position event (amounts already decimal-adjusted; Y vs X per the pool). */
export interface PositionHistoryEvent {
  kind: string; // 'deposit' | 'withdraw' | 'claim' | 'open' | 'close' | ...
  amountX: number;
  amountY: number;
}

/** A position's decoded DLMM history: per-position deposit/withdraw/claim amounts + the leg mints. */
export interface PositionHistoryLike {
  tokenXMint: string;
  tokenYMint: string;
  events: PositionHistoryEvent[];
}

/**
 * Exact SOL leg + net residual for a position from its decoded DLMM events (the LPAgent-grade source:
 * per-position amounts, immune to the wallet's aggregate native flow over-counting multi-position
 * opens). SOL leg = withdrawn + claimed − deposited on the SOL side; residual = net non-SOL taken out
 * (withdraw + claim − deposit), i.e. the leftover token (incl. in-kind fees) the wallet must sell.
 */
export function flowFromHistory(hist: PositionHistoryLike): {
  solLegSol: number;
  residualAmount: number;
  residualMint: string;
} {
  const yIsSol = hist.tokenYMint === SOL_MINT;
  const xIsSol = hist.tokenXMint === SOL_MINT;
  const solOf = (e: PositionHistoryEvent) => (yIsSol ? e.amountY : xIsSol ? e.amountX : 0);
  const tokOf = (e: PositionHistoryEvent) => (yIsSol ? e.amountX : e.amountY);
  let sol = 0;
  let tok = 0;
  for (const e of hist.events) {
    const sign = e.kind === 'deposit' ? -1 : e.kind === 'withdraw' || e.kind === 'claim' ? 1 : 0;
    sol += sign * solOf(e);
    tok += sign * tokOf(e);
  }
  return {
    solLegSol: sol,
    residualAmount: Math.max(0, tok),
    residualMint: yIsSol ? hist.tokenXMint : hist.tokenYMint,
  };
}
