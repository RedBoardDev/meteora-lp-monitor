/**
 * Copy-bot · read a RELATIVE token-price proxy from a pool's active bin — ONE getAccountInfo (decode the lbPair
 * account; no DLMM.create), cheap enough for the rug-SL price poll. DEFENSIVE: returns null on any read/decode
 * failure or a non-positive/non-finite result, so a bad read NEVER feeds a garbage price into the crash detector.
 *
 * NOTE: this is the RAW bin price (not decimal-adjusted), so the absolute value is not a human price — but rug-SL
 * only cares about the RELATIVE drop (−X% from the recent high), where a constant decimals factor cancels out. So
 * the raw price is exactly right for crash detection; do NOT use it as a quote/valuation price.
 */
import type { Connection, PublicKey } from '@solana/web3.js';
import { solSideOf } from '@/domain/dlmm-pnl';
import { decodeLbPair } from './layout';

/** Token price in SOL from the active bin. `(1+binStep/1e4)^activeId` = price of X in Y; orient by which side is SOL. */
export function activeBinPrice(activeId: number, binStep: number, solSide: 'X' | 'Y'): number {
  const xPricedInY = (1 + binStep / 10_000) ** activeId;
  return solSide === 'Y' ? xPricedInY : 1 / xPricedInY; // non-SOL token priced in SOL
}

/** The pool's current non-SOL token price in SOL, or null (no SOL side / read fails / garbage) — never throws. */
export async function readActiveTokenPrice(conn: Connection, pool: PublicKey): Promise<number | null> {
  let account: Awaited<ReturnType<Connection['getAccountInfo']>>;
  try {
    account = await conn.getAccountInfo(pool);
  } catch {
    return null;
  }
  if (!account) return null;
  let lb: ReturnType<typeof decodeLbPair>;
  try {
    lb = decodeLbPair(account.data);
  } catch {
    return null;
  }
  const solSide = solSideOf(lb.tokenXMint.toBase58(), lb.tokenYMint.toBase58());
  if (solSide === null) return null; // non-SOL-quote pool → no SOL-denominated token price
  const price = activeBinPrice(lb.activeId, lb.binStep, solSide);
  return Number.isFinite(price) && price > 0 ? price : null;
}
