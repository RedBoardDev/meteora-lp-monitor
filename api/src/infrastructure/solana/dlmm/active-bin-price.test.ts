import { SOL_MINT } from '@binsight/shared';
import { type Connection, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { activeBinPrice, readActiveTokenPrice } from './active-bin-price';

const LBPAIR_DISC = [33, 11, 49, 98, 181, 101, 177, 13];
const OTHER_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC (not SOL)

/** Build a minimal valid LbPair account buffer (disc + activeId@76 + binStep@80 + mintX@88 + mintY@120). */
function lbPairBuffer(activeId: number, binStep: number, xMint: PublicKey, yMint: PublicKey): Buffer {
  const b = Buffer.alloc(882); // must reach the yProgramFlag byte (881)
  for (let i = 0; i < 8; i += 1) b[i] = LBPAIR_DISC[i] as number;
  b.writeInt32LE(activeId, 76);
  b.writeUInt16LE(binStep, 80);
  Buffer.from(xMint.toBytes()).copy(b, 88);
  Buffer.from(yMint.toBytes()).copy(b, 120);
  return b;
}

describe('active-bin-price · activeBinPrice (pure)', () => {
  it('orients the price by the SOL side', () => {
    const xPricedInY = (1 + 20 / 10_000) ** 100;
    // SOL is Y → token X price in SOL = xPricedInY ; SOL is X → token Y price in SOL = 1/xPricedInY.
    expect(activeBinPrice(100, 20, 'Y')).toBeCloseTo(xPricedInY, 10);
    expect(activeBinPrice(100, 20, 'X')).toBeCloseTo(1 / xPricedInY, 10);
  });

  it('is monotonic in the active bin id (higher bin = higher X-in-Y price)', () => {
    expect(activeBinPrice(101, 20, 'Y')).toBeGreaterThan(activeBinPrice(100, 20, 'Y'));
  });

  it('is always positive', () => {
    for (const id of [-500, -1, 0, 1, 8000]) expect(activeBinPrice(id, 10, 'Y')).toBeGreaterThan(0);
  });
});

const pool = {} as PublicKey;
const connWith = (getAccountInfo: () => unknown): Connection => ({ getAccountInfo: vi.fn(getAccountInfo) }) as unknown as Connection;

describe('active-bin-price · readActiveTokenPrice (defensive — a bad read never yields a price)', () => {
  it('returns null when the account is missing', async () => {
    expect(await readActiveTokenPrice(connWith(() => null), pool)).toBeNull();
  });

  it('returns null when getAccountInfo throws (RPC blip) — no garbage price', async () => {
    expect(await readActiveTokenPrice(connWith(() => { throw new Error('rpc down'); }), pool)).toBeNull();
  });

  it('returns null on a non-LbPair account (decode fails)', async () => {
    expect(await readActiveTokenPrice(connWith(() => ({ data: Buffer.alloc(8) })), pool)).toBeNull();
  });

  it('returns the RAW active-bin price for a valid SOL-quote pool (SOL on Y → token X price in SOL)', async () => {
    const data = lbPairBuffer(100, 20, OTHER_MINT, new PublicKey(SOL_MINT));
    const price = await readActiveTokenPrice(connWith(() => ({ data })), pool);
    expect(price).toBeCloseTo(activeBinPrice(100, 20, 'Y'), 10); // matches the pure formula for the SOL side
    expect(price).toBeGreaterThan(0);
  });

  it('returns null for a non-SOL-quote pool (no SOL-denominated price exists)', async () => {
    // WHY: rug-SL works on a SOL-relative price; a pool with neither leg in SOL must yield null, not a bogus number.
    const data = lbPairBuffer(100, 20, OTHER_MINT, OTHER_MINT);
    expect(await readActiveTokenPrice(connWith(() => ({ data })), pool)).toBeNull();
  });
});
