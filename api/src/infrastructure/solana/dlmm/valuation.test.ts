import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import type { DecodedPosition } from './layout';
import { coverageIndices, valuePosition } from './valuation';

describe('coverageIndices (bin-array coverage, floor toward -inf)', () => {
  it('handles a single negative-bin array', () => {
    // -464..-426 both floor to -7 (×70 = -490..-421)
    expect(coverageIndices(-464, -426)).toEqual([-7]);
  });

  it('spans the zero boundary correctly', () => {
    expect(coverageIndices(-90, 5)).toEqual([-2, -1, 0]);
  });

  it('covers a wide positive range across several arrays', () => {
    expect(coverageIndices(0, 210)).toEqual([0, 1, 2, 3]); // 210 → index 3
  });
});

const KEY = new PublicKey('So11111111111111111111111111111111111111112');
/** A one-bin position [0,0] holding `share` liquidity, with zeroed fee accumulators. */
const onebin = (share: bigint): DecodedPosition => ({
  lbPair: KEY,
  owner: KEY,
  lowerBinId: 0,
  upperBinId: 0,
  shares: [share],
  feeInfos: [{ completeX: 0n, completeY: 0n, pendingX: 0n, pendingY: 0n }],
});

describe('valuePosition completeness (R11: under-counted when a bin-array is missing)', () => {
  it('flags incomplete when a share>0 bin has no fetched bin-array — amounts are silently dropped', () => {
    // The held bin has no bin-array in the map (RPC didn't return it). The old code returned the
    // under-counted amounts as if final; now the deflation is surfaced via `complete: false`.
    const v = valuePosition(onebin(1n), new Map());
    expect(v.complete).toBe(false);
    expect(v.amountX).toBe(0n); // the held amount WAS dropped — this is exactly why it must flag
    expect(v.amountY).toBe(0n);
  });

  it('is complete when no bin holds a share (nothing could be under-counted)', () => {
    expect(valuePosition(onebin(0n), new Map()).complete).toBe(true);
  });
});
