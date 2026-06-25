/**
 * Copy-bot · P2 — ENTRY decision (PURE, no I/O, no key). For a leader open, says what we WOULD do in
 * paper: copy at what size, or skip with a reason. Composes the entry gates + the sizing brick (2.2).
 *
 * The scope of this increment = the entry (open). The mirror-close / exits (P2.4) and the optional filters
 * (P2.3, all OFF by default) will come as additional bricks. The only ON-by-default gate here is the
 * skip of non-SOL pools (spec: we don't copy non-SOL / 2-sided).
 *
 * The `outcome` is aligned with the `copies.outcome` column of the data model (spec 11 §2.3) to plug
 * directly into the paper shadow-log.
 */
import type { DetectedEvent } from './events';
import { type FilterConfig, type FilterContext, runFilters } from './filters';
import { type FollowerState, type SizingConfig, computeCopySize } from './sizing';

export interface EntryConfig extends SizingConfig {
  /** Skip positions whose pool is not SOL-paired (default true — spec non-goals). */
  skipNonSolPaired: boolean;
}

export type EntryDecision =
  | { outcome: 'mirrored' | 'reduced'; sizeSol: number; leaderSizeSol: number }
  | { outcome: 'skipped'; reason: string; leaderSizeSol: number };

/**
 * Decides the entry for a leader open event. Order: non-SOL gate → filters (P2.3, OFF by default) → sizing.
 * `leaderSizeSol` = the open's deposit size (spec 05 §3), carried by `event.depositSol`. Pure.
 */
export function decideEntry(
  event: DetectedEvent,
  config: EntryConfig,
  follower: FollowerState,
  filters?: { ctx: FilterContext; config: FilterConfig },
): EntryDecision {
  const leaderSizeSol = event.depositSol;

  // ON-by-default gate: pool not valuable in SOL (nonSolMint absent) ⇒ we don't copy.
  if (config.skipNonSolPaired && event.nonSolMint == null) {
    return { outcome: 'skipped', reason: 'non_sol_paired', leaderSizeSol };
  }

  // Entry filters (all OFF by default) — before sizing: no point sizing what we reject.
  if (filters) {
    const v = runFilters({ nonSolMint: event.nonSolMint, pool: event.pool }, filters.ctx, filters.config);
    if (v.action === 'skip') return { outcome: 'skipped', reason: v.reason, leaderSizeSol };
  }

  const sized = computeCopySize(config, leaderSizeSol, follower);
  if (sized.action === 'skip') return { outcome: 'skipped', reason: sized.reason, leaderSizeSol };
  return { outcome: sized.reduced ? 'reduced' : 'mirrored', sizeSol: sized.sizeSol, leaderSizeSol };
}
