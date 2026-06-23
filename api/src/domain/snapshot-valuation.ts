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

  let tvl = 0;
  let fees = 0;
  let rent = 0;
  const sizeBy = new Map<string, number>();
  const feeBy = new Map<string, number>();

  for (const p of snap.positions) {
    const yIsSol = p.tokenYMint === SOL_MINT;
    // Fallbacks from the on-chain pool price: X-in-SOL when Y is SOL; Y-in-SOL when X is SOL.
    const poolXinY = poolPriceXinY(p);
    const pX = priceOf(p.tokenXMint, yIsSol ? poolXinY : 0);
    const pY = priceOf(p.tokenYMint, p.tokenXMint === SOL_MINT && poolXinY > 0 ? 1 / poolXinY : 0);
    const size = ui(p.amountX, p.decimalsX) * pX + ui(p.amountY, p.decimalsY) * pY;
    const fee = ui(p.feeX, p.decimalsX) * pX + ui(p.feeY, p.decimalsY) * pY;
    sizeBy.set(p.positionAddress, size);
    feeBy.set(p.positionAddress, fee);
    tvl += size;
    fees += fee;
    rent += Number(p.lamports) / LAMPORTS_PER_SOL;
  }

  let idle = Number(snap.nativeLamports) / LAMPORTS_PER_SOL;
  for (const t of snap.idleTokens) idle += ui(t.amount, t.decimals) * priceOf(t.mint, 0);

  return {
    slot: snap.slot,
    slotSkew: snap.slotSkew,
    tvlSol: tvl,
    idleSol: idle,
    unclaimedFeesSol: fees,
    lockedRentSol: rent,
    walletTotalSol: tvl + idle + fees + rent,
    positionCount: snap.positions.length,
    sizeSolByPosition: sizeBy,
    feeSolByPosition: feeBy,
  };
}
