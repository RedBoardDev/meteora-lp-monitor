import { createHash } from 'node:crypto';

/**
 * Strategy family decoded from a position-open instruction. Spot / Curve / BidAsk are the SDK
 * StrategyType families; the on-chain enum has 9 variants (× OneSide/Balanced/ImBalanced) and
 * `family = value % 3` (0 Spot, 1 Curve, 2 BidAsk). Validated 69/69 vs LPAgent's strategyType label.
 */
export type StrategyFamily = 'Spot' | 'Curve' | 'BidAsk';

const FAMILY: StrategyFamily[] = ['Spot', 'Curve', 'BidAsk'];

const anchorDisc = (name: string): Buffer =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);

/**
 * DLMM instructions that carry a StrategyType, with the byte offset of the `strategy_type` u8 in the
 * instruction data. by_strategy/by_strategy2 have two amounts (offset 40); the one-sided variant has a
 * single amount (offset 32). Layout: disc(8) + amountX(8)[+amountY(8)] + activeId(4) + slippage(4) +
 * minBinId(4) + maxBinId(4) + strategyType(1).
 */
const STRATEGY_IXS: { disc: Buffer; offset: number }[] = [
  { disc: anchorDisc('add_liquidity_by_strategy'), offset: 40 },
  { disc: anchorDisc('add_liquidity_by_strategy2'), offset: 40 },
  { disc: anchorDisc('initialize_position_and_add_liquidity_by_strategy'), offset: 40 },
  { disc: anchorDisc('initialize_position_and_add_liquidity_by_strategy2'), offset: 40 },
  { disc: anchorDisc('add_liquidity_by_strategy_one_side'), offset: 32 },
];

const discEquals = (data: Uint8Array, disc: Buffer): boolean => {
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return false;
  return true;
};

/** Decode a DLMM instruction's data into a strategy family, or null if it carries no strategyType. */
export function decodeStrategy(
  data: Uint8Array,
): { strategyType: number; family: StrategyFamily } | null {
  for (const { disc, offset } of STRATEGY_IXS) {
    if (data.length > offset && discEquals(data, disc)) {
      const strategyType = data[offset]!;
      const family = FAMILY[strategyType % 3];
      if (!family) return null;
      return { strategyType, family };
    }
  }
  return null;
}
