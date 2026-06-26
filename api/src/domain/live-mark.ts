import { type OpenPosition, SOL_MINT } from '@binsight/shared';
import type { OnchainPositionValue, OnchainValued, OnchainWalletSnapshot } from './dlmm';
import { resolveRangeStatus } from './position';
import { valueSnapshot } from './snapshot-valuation';

/**
 * APPROXIMATE live mark — the value-on-demand replacement for the deleted 30s per-wallet snapshot timer.
 *
 * Re-prices a wallet's CACHED on-chain snapshot (raw token amounts from the last EXACT read) at the
 * current Jupiter SOL price, with NO RPC (no getMultipleAccounts). The token amounts are held fixed, so
 * this is an approximation — the real bin liquidity redistributes between X and Y as the price moves
 * through bins — but it tracks the wallet's value + each position's in/out-of-range live, for the UI only.
 * The valuation is flagged `complete: false` so the NetworthRecorder NEVER persists it as authoritative;
 * only an EXACT on-chain read (a WS position-set change / close / detail view) is persisted. Pure: no I/O.
 */

/**
 * Fresh UI pool price (token-X expressed in token-Y units, the space minPrice/maxPrice live in) derived
 * from Jupiter SOL prices. Only resolvable for SOL-quote pools:
 *   - Y is SOL → price(X in SOL) is exactly X-in-Y.
 *   - X is SOL → price(Y in SOL) inverts to X(=SOL)-in-Y.
 * Returns null for a non-SOL-quote pool or a missing/zero quote → caller keeps the cached pool price.
 */
export function livePoolPrice(
  p: Pick<OnchainPositionValue, 'tokenXMint' | 'tokenYMint'>,
  priceSol: Map<string, number>,
): number | null {
  if (p.tokenYMint === SOL_MINT) {
    const px = priceSol.get(p.tokenXMint);
    return px != null && px > 0 ? px : null;
  }
  if (p.tokenXMint === SOL_MINT) {
    const py = priceSol.get(p.tokenYMint);
    return py != null && py > 0 ? 1 / py : null;
  }
  return null;
}

/** Re-mark one open position row from its cached raw holdings + the fresh price. Value/fees come from the
 *  re-valued snapshot; range from the fresh pool price vs the position's cached [minPrice, maxPrice]
 *  (which derive from its fixed [lowerBinId, upperBinId]). uPnL tracks the live size/fees by the exact
 *  linear delta (deposit basis is constant); pnl% rescales by the recovered deposit basis when known. */
function remarkRow(
  o: OpenPosition,
  raw: OnchainPositionValue,
  valued: OnchainValued,
  priceSol: Map<string, number>,
): OpenPosition {
  const sizeSol = valued.sizeSolByPosition.get(o.positionAddress) ?? o.sizeSol;
  const unclaimedFeesSol = valued.feeSolByPosition.get(o.positionAddress) ?? o.unclaimedFeesSol;
  const poolPrice = livePoolPrice(raw, priceSol) ?? o.poolPrice;
  const rangeStatus = resolveRangeStatus(poolPrice, o.minPrice, o.maxPrice);
  const pnlSol = o.pnlSol + (sizeSol - o.sizeSol) + (unclaimedFeesSol - o.unclaimedFeesSol);
  const depositSol = o.pnlPctSol !== 0 ? (o.pnlSol / o.pnlPctSol) * 100 : 0;
  const pnlPctSol = depositSol > 0 ? (pnlSol / depositSol) * 100 : o.pnlPctSol;
  return {
    ...o,
    sizeSol,
    unclaimedFeesSol,
    poolPrice,
    rangeStatus,
    pnlSol,
    pnlPctSol,
    updatedAt: o.updatedAt,
  };
}

/**
 * Approximate live mark of a wallet from its cached snapshot + the fresh price map.
 *  - `valued`: the re-priced wallet valuation (totals + per-position sizes), forced `complete: false`
 *    so it is DISPLAY-ONLY and never persisted as a net-worth point.
 *  - `open`: the given open rows re-marked (size/fees/poolPrice/range/uPnL). Rows whose position is no
 *    longer in the cached snapshot are returned untouched.
 */
export function liveMarkWallet(
  snapshot: OnchainWalletSnapshot,
  open: OpenPosition[],
  priceSol: Map<string, number>,
): { valued: OnchainValued; open: OpenPosition[] } {
  const valued: OnchainValued = { ...valueSnapshot(snapshot, priceSol), complete: false };
  const rawByAddr = new Map(snapshot.positions.map((p) => [p.positionAddress, p]));
  const marked = open.map((o) => {
    const raw = rawByAddr.get(o.positionAddress);
    return raw ? remarkRow(o, raw, valued, priceSol) : o;
  });
  return { valued, open: marked };
}
