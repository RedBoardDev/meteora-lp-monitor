import { utils } from '@coral-xyz/anchor';
import { type Connection, PublicKey } from '@solana/web3.js';
import type { StrategyResolver as StrategyResolverPort } from '@/domain/ports';
import { DLMM_PROGRAM_ID } from './layout';
import { decodeStrategy, type StrategyFamily } from './strategy';

/** base58 decode; invalid input yields an empty array (decodeStrategy then reports no family). */
function bs58decode(s: string): Uint8Array {
  try {
    return utils.bytes.bs58.decode(s);
  } catch {
    return new Uint8Array();
  }
}

/**
 * Resolves a position's strategy family (Spot/Curve/BidAsk) ONCE from its on-chain open transaction.
 * Strategy is not stored in the position account — it lives only in the add-liquidity instruction data.
 * Works for closed positions too (Solana keeps an address's signature history after the account closes).
 */
export class StrategyResolver implements StrategyResolverPort {
  constructor(private readonly conn: Connection) {}

  async resolve(positionAddress: string): Promise<StrategyFamily | null> {
    const sig = await this.oldestSignature(new PublicKey(positionAddress));
    return sig ? this.fromTransaction(sig) : null;
  }

  /** The position's first-ever signature is its creation tx (which carries the add-liquidity ix). */
  private async oldestSignature(pk: PublicKey): Promise<string | null> {
    let before: string | undefined;
    let oldest: string | null = null;
    for (let page = 0; page < 10; page++) {
      const sigs = await this.conn.getSignaturesForAddress(pk, { limit: 1000, before });
      if (sigs.length === 0) break;
      oldest = sigs[sigs.length - 1]?.signature ?? oldest;
      if (sigs.length < 1000) break;
      before = oldest ?? undefined;
    }
    return oldest;
  }

  async fromTransaction(signature: string): Promise<StrategyFamily | null> {
    const tx = await this.conn.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx) return null;
    const scan = (
      ixs: readonly { programId: PublicKey; data?: string }[],
    ): StrategyFamily | null => {
      for (const ix of ixs) {
        if (typeof ix.data === 'string' && ix.programId.equals(DLMM_PROGRAM_ID)) {
          const s = decodeStrategy(bs58decode(ix.data));
          if (s) return s.family;
        }
      }
      return null;
    };
    const top = scan(
      tx.transaction.message.instructions as { programId: PublicKey; data?: string }[],
    );
    if (top) return top;
    for (const inner of tx.meta?.innerInstructions ?? []) {
      const r = scan(inner.instructions as { programId: PublicKey; data?: string }[]);
      if (r) return r;
    }
    return null;
  }
}
