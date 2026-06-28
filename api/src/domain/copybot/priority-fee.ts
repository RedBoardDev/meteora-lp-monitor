/**
 * Copy-bot · priority fee — PURE tier→CU-price mapping + hard SOL cap (no web3, no I/O).
 *
 * A tx's priority fee = `computeUnitPrice (µLamports/CU) × CU used`. We pick the price from a TIER and bound it by
 * a hard SOL cap: the price is capped so that `price × cuLimit` (the worst case) never exceeds `maxCapSol`. The cap
 * ALWAYS wins, so an aggressive tier can never overspend. See docs/reference/copybot-settings.md §5.
 */
export const PRIORITY_FEE_TIERS = ['low', 'medium', 'high'] as const;
export type PriorityFeeTier = (typeof PRIORITY_FEE_TIERS)[number];

export interface PriorityFeeConfig {
  tier: PriorityFeeTier;
  /** Hard ceiling (SOL) on the priority fee per tx, regardless of tier. */
  maxCapSol: number;
}

const LAMPORTS_PER_SOL = 1_000_000_000;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000;

/** Target compute-unit price per tier, in µLamports/CU (starting calibration; bounded by the cap). */
const TIER_MICRO_LAMPORTS_PER_CU: Record<PriorityFeeTier, number> = {
  low: 50_000,
  medium: 200_000,
  high: 1_000_000,
};

/**
 * The compute-unit price (µLamports/CU) to set, given the tx's CU limit and the user cap. Capped so the worst-case
 * fee (`price × cuLimit`) stays under `maxCapSol`. Returns 0 when there's nothing to set (no CU, or a zero cap).
 */
export function computeUnitPriceMicroLamports(tier: PriorityFeeTier, cuLimit: number, maxCapSol: number): number {
  if (cuLimit <= 0 || maxCapSol <= 0) return 0;
  const base = TIER_MICRO_LAMPORTS_PER_CU[tier];
  const capLamports = maxCapSol * LAMPORTS_PER_SOL;
  // price × cuLimit / MICRO_LAMPORTS_PER_LAMPORT ≤ capLamports  ⟹  price ≤ capLamports × MICRO/cuLimit
  const capPrice = Math.floor((capLamports * MICRO_LAMPORTS_PER_LAMPORT) / cuLimit);
  return Math.max(0, Math.min(base, capPrice));
}
