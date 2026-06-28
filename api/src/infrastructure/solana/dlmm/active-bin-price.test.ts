import type { Connection, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { activeBinPrice, readActiveTokenPrice } from './active-bin-price';

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
});
