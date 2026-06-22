import { type Connection, PublicKey } from '@solana/web3.js';
import type { LoadedPoolMeta } from '@/domain/dlmm';
import { solSideOf } from '@/domain/dlmm-pnl';
import type { PoolMetaReader } from '@/domain/ports';
import { dlmmCoder } from './dlmm-coder';

const fieldStr = (v: unknown): string =>
  v && typeof (v as { toString: () => string }).toString === 'function'
    ? (v as { toString: () => string }).toString()
    : '';

/**
 * Load a pool's binStep + SOL side + mints from its on-chain LbPair account, decoded by the official IDL.
 * solSide is null for a non-SOL-quote pool (neither token is SOL) — still returned so callers can surface
 * the position flagged rather than drop it. Null only on a missing/undecodable account. Cache per pool.
 */
async function loadPoolMeta(conn: Connection, pool: PublicKey): Promise<LoadedPoolMeta | null> {
  const info = await conn.getAccountInfo(pool);
  if (!info) return null;
  let lb: Record<string, unknown>;
  try {
    lb = dlmmCoder.accounts.decode('LbPair', info.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const binStep = Number(lb.binStep ?? lb.bin_step ?? 0);
  const mintX = fieldStr(lb.tokenXMint ?? lb.token_x_mint);
  const mintY = fieldStr(lb.tokenYMint ?? lb.token_y_mint);
  if (!binStep || !mintX || !mintY) return null;
  // solSide null = non-SOL-quote pool: still returned (flagged) so the projection surfaces it, never drops it.
  return { binStep, solSide: solSideOf(mintX, mintY), mintX, mintY };
}

/** Connection-bound adapter so the free {@link loadPoolMeta} can be injected behind the PoolMetaReader port. */
export class OnchainPoolMetaReader implements PoolMetaReader {
  constructor(private readonly conn: Connection) {}

  loadPoolMeta(pool: string): Promise<LoadedPoolMeta | null> {
    return loadPoolMeta(this.conn, new PublicKey(pool));
  }
}
