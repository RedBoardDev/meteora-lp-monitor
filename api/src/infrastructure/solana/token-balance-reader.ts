/**
 * Copy-bot — read the owner's residual balance (raw units) of a given mint, summed across all its token
 * accounts. Used after a close to size the Jupiter residual sell. The summation is a pure, tested helper.
 */
import { type Connection, PublicKey } from '@solana/web3.js';

type ParsedTokenData = { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } };

/** Both SPL token programs MUST be swept: most pump.fun tokens are Token-2022, and a leader's residual leg is
 *  frequently a Token-2022 mint — missing it leaves a dormant non-SOL balance (the exact no-miss failure). */
const TOKEN_PROGRAM_IDS = [
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // classic SPL Token
  new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), // Token-2022
];

/** Sum raw token amounts (strings) into a bigint, ignoring missing/empty entries. Pure. */
export function sumTokenAmounts(amounts: Array<string | undefined>): bigint {
  let total = 0n;
  for (const a of amounts) if (a) total += BigInt(a);
  return total;
}

/** Group raw token amounts by mint into bigints (sums multiple accounts of one mint, drops zero/empty). Pure. */
export function groupTokenBalancesByMint(entries: Array<{ mint?: string; amount?: string }>): Array<{ mint: string; amountRaw: bigint }> {
  const byMint = new Map<string, bigint>();
  for (const e of entries) {
    if (!e.mint || !e.amount) continue;
    byMint.set(e.mint, (byMint.get(e.mint) ?? 0n) + BigInt(e.amount));
  }
  return [...byMint].filter(([, amt]) => amt > 0n).map(([mint, amountRaw]) => ({ mint, amountRaw }));
}

/** Owner's total balance of `mint` in raw units (across every token account). I/O. */
export async function readOwnerTokenBalance(conn: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const res = await conn.getParsedTokenAccountsByOwner(owner, { mint });
  return sumTokenAmounts(res.value.map(({ account }) => (account.data as ParsedTokenData).parsed?.info?.tokenAmount?.amount));
}

/** Owner's balances for EVERY SPL token across BOTH token programs (classic + Token-2022), raw units, grouped
 *  by mint, zero-balances dropped. I/O. Backs the no-miss safety sweep: any non-SOL token is found and swept. */
export async function readAllOwnerTokenBalances(conn: Connection, owner: PublicKey): Promise<Array<{ mint: string; amountRaw: bigint }>> {
  const perProgram = await Promise.all(TOKEN_PROGRAM_IDS.map((programId) => conn.getParsedTokenAccountsByOwner(owner, { programId })));
  const entries = perProgram.flatMap((res) =>
    res.value.map(({ account }) => {
      const info = (account.data as ParsedTokenData).parsed?.info;
      return { mint: info?.mint, amount: info?.tokenAmount?.amount };
    }),
  );
  return groupTokenBalancesByMint(entries);
}
