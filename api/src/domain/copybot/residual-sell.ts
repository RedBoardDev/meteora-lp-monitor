/**
 * Copy-bot · fast residual sell (PURE core, no I/O). When the leader closes, our close removes liquidity and
 * returns SOL + a residual NON-SOL token leg; we immediately swap that residual back to SOL (Jupiter, built by
 * the brain → verified by Wall B → signed+landed by the vault). This module holds the deterministic decisions
 * around that swap; the Jupiter quote/route fetch is the I/O layer.
 *
 * "Fast and never fails": skip true dust (Jupiter errors on tiny amounts → wasted attempt), and never accept a
 * route below a slippage floor (protects against MEV / a bad route while still being permissive enough to land).
 */

const BPS_DENOMINATOR = 10_000n; // basis-points base (100% = 10000 bps)

export interface ResidualSellDecision {
  sell: boolean;
  /** present only when sell=false — why we skip the swap. */
  reason?: 'no_residual' | 'dust';
}

/**
 * Decide whether the residual token leg is worth swapping. Below `dustThresholdRaw` (raw token units) we skip:
 * the swap would either fail or cost more in fees than it returns. Pure.
 */
export function decideResidualSell(tokenBalanceRaw: bigint, dustThresholdRaw: bigint): ResidualSellDecision {
  if (tokenBalanceRaw <= 0n) return { sell: false, reason: 'no_residual' };
  if (tokenBalanceRaw <= dustThresholdRaw) return { sell: false, reason: 'dust' };
  return { sell: true };
}

export interface OwnerTokenBalance {
  mint: string;
  amountRaw: bigint;
}

/**
 * Select which of the wallet's token balances to sweep back to SOL (the no-miss safety net behind the
 * close-triggered sell): every non-SOL mint above dust. Skips wSOL — it is SOL already (a swap would be
 * circular; it is unwrapped natively instead). Pure; reuses `decideResidualSell` for the per-token cutoff.
 */
export function planWalletSweep(balances: OwnerTokenBalance[], wsolMint: string, dustThresholdRaw: bigint): OwnerTokenBalance[] {
  return balances.filter((b) => b.mint !== wsolMint && decideResidualSell(b.amountRaw, dustThresholdRaw).sell);
}

/**
 * Minimum acceptable output (in lamports) for a quoted swap output, given a slippage tolerance in bps. The
 * landed tx must return at least this much SOL or it reverts — the "never sell into a terrible route" floor.
 * Pure, bigint-exact (floor division).
 */
export function minOutWithSlippage(quotedOutLamports: bigint, slippageBps: number): bigint {
  if (slippageBps < 0) throw new Error('slippageBps must be >= 0');
  const keptBps = BPS_DENOMINATOR - BigInt(slippageBps);
  return (quotedOutLamports * keptBps) / BPS_DENOMINATOR;
}
