import { describe, expect, it } from 'vitest';
import { decodeStrategy } from './strategy';

// Real `add_liquidity_by_strategy2` instruction data from the position-open tx of 2N2GmK…ns2D
// (LPAgent UI label: "Spot"). strategyType byte @offset 40 = 0x06 (SpotImBalanced).
const REAL_BY_STRATEGY2 =
  '03dd95da6f8d76d50000000000000000f95f15320800000056feffff0c00000030feffff56feffff06000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000100';

const BY_STRATEGY2_DISC = [3, 221, 149, 218, 111, 141, 118, 213];

describe('decodeStrategy', () => {
  it('decodes a real add_liquidity_by_strategy2 ix as SpotImBalanced → Spot', () => {
    const r = decodeStrategy(Buffer.from(REAL_BY_STRATEGY2, 'hex'));
    expect(r).toEqual({ strategyType: 6, family: 'Spot' });
  });

  it('maps family = strategyType % 3 for every on-chain variant (offset 40)', () => {
    const expected = ['Spot', 'Curve', 'BidAsk'];
    for (let t = 0; t <= 8; t++) {
      const data = Buffer.alloc(50);
      Buffer.from(BY_STRATEGY2_DISC).copy(data, 0);
      data[40] = t;
      expect(decodeStrategy(data)).toEqual({ strategyType: t, family: expected[t % 3] });
    }
  });

  it('returns null for a non-strategy instruction', () => {
    const data = Buffer.alloc(50);
    data.fill(0xab, 0, 8); // unknown discriminator
    expect(decodeStrategy(data)).toBeNull();
  });
});
