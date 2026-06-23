import { SOL_MINT } from '@binsight/shared';
import type { OnchainPositionValue, OnchainValued, OnchainWalletSnapshot } from './dlmm';
import { binPriceRaw, LAMPORTS_PER_SOL } from './dlmm-pnl';

const ui = (amount: bigint, decimals: number): number => Number(amount) / 10 ** decimals;

/** Pool active-bin price of token X expressed in token Y (UI units).
 *  raw base-unit price = (1+binStep/10000)^activeId; UI price = raw · 10^(decX−decY).
 *  Verified against the datapi `poolActivePrice` (e.g. DRA/SOL: 1.01^-777 · 10^(6-9) = 4.39e-7). */
function poolPriceXinY(p: OnchainPositionValue): number {
  return binPriceRaw(p.activeId, p.binStep) * 10 ** (p.decimalsX - p.decimalsY);
}

/** All non-SOL mints that need a Jupiter SOL price for a snapshot. */
export function mintsNeedingPrice(snap: OnchainWalletSnapshot): string[] {
  const s = new Set<string>();
  for (const p of snap.positions) {
    if (p.tokenXMint !== SOL_MINT) s.add(p.tokenXMint);
    if (p.tokenYMint !== SOL_MINT) s.add(p.tokenYMint);
  }
  for (const t of snap.idleTokens) if (t.mint !== SOL_MINT) s.add(t.mint);
  return [...s];
}

export function valueSnapshot(
  snap: OnchainWalletSnapshot,
  priceSol: Map<string, number>,
): OnchainValued {
  const priceOf = (mint: string, fallback: number): number =>
    mint === SOL_MINT ? 1 : (priceSol.get(mint) ?? fallback);
  // A non-SOL mint is "priced" only when Jupiter quoted it (the map omits misses, and every quote is
  // >0) OR the on-chain pool gives a real (>0) fallback. A held mint that resolves to neither is
  // silently valued at 0 → the total is deflated → the valuation is incomplete (not persisted as fresh).
  const priced = (mint: string, fallback: number): boolean =>
    mint === SOL_MINT || priceSol.has(mint) || fallback > 0;

  // Start from the chain-read completeness (unfetched bin-array / unknown decimals — see snapshotWallet),
  // then fold in price completeness below.
  let complete = snap.complete;
  let tvl = 0;
  let fees = 0;
  let rent = 0;
  const sizeBy = new Map<string, number>();
  const feeBy = new Map<string, number>();

  for (const p of snap.positions) {
    const yIsSol = p.tokenYMint === SOL_MINT;
    // Fallbacks from the on-chain pool price: X-in-SOL when Y is SOL; Y-in-SOL when X is SOL.
    const poolXinY = poolPriceXinY(p);
    const fbX = yIsSol ? poolXinY : 0;
    const fbY = p.tokenXMint === SOL_MINT && poolXinY > 0 ? 1 / poolXinY : 0;
    const pX = priceOf(p.tokenXMint, fbX);
    const pY = priceOf(p.tokenYMint, fbY);
    // Only a side that actually holds value (tokens or unclaimed fees) can deflate the total.
    if ((p.amountX > 0n || p.feeX > 0n) && !priced(p.tokenXMint, fbX)) complete = false;
    if ((p.amountY > 0n || p.feeY > 0n) && !priced(p.tokenYMint, fbY)) complete = false;
    const size = ui(p.amountX, p.decimalsX) * pX + ui(p.amountY, p.decimalsY) * pY;
    const fee = ui(p.feeX, p.decimalsX) * pX + ui(p.feeY, p.decimalsY) * pY;
    sizeBy.set(p.positionAddress, size);
    feeBy.set(p.positionAddress, fee);
    tvl += size;
    fees += fee;
    rent += Number(p.lamports) / LAMPORTS_PER_SOL;
  }

  let idle = Number(snap.nativeLamports) / LAMPORTS_PER_SOL;
  for (const t of snap.idleTokens) {
    idle += ui(t.amount, t.decimals) * priceOf(t.mint, 0);
    if (t.amount > 0n && !priced(t.mint, 0)) complete = false;
  }

  return {
    slot: snap.slot,
    slotSkew: snap.slotSkew,
    tvlSol: tvl,
    idleSol: idle,
    unclaimedFeesSol: fees,
    lockedRentSol: rent,
    walletTotalSol: tvl + idle + fees + rent,
    positionCount: snap.positions.length,
    complete,
    sizeSolByPosition: sizeBy,
    feeSolByPosition: feeBy,
  };
}
