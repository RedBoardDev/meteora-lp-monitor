/**
 * Copy-bot · event ROUTING (PURE, no I/O). Decides which mirror action a detected leader event maps to, given
 * whether we already track that position. Extracted from the brain so the routing — a #1 robustness property — is
 * unit-testable in isolation: a fee CLAIM must NEVER be mis-routed to a close (which would false-close our copy) or
 * to a resize, and an event on an untracked position must be ignored (no stale copying). The order is significant:
 * a close is checked BEFORE a withdraw because a close also withdraws.
 */
import { classifyInstruction } from '../dlmm';
import type { DetectedEvent } from './events';

/** What the brain should do with a detected event. `resync` = re-shape our copy to the leader's new size/shape. */
export type EventAction = 'open' | 'resync' | 'close' | 'claim' | 'ignore';

/** The config that affects ROUTING (not sizing). `infiniteAdd`: grow on a leader add. `claimFloorSol`: skip dust claims. */
export interface RoutingConfig {
  infiniteAdd: boolean;
  claimFloorSol: number;
}

export function classifyEventAction(e: DetectedEvent, tracked: boolean, cfg: RoutingConfig, rugExited = false): EventAction {
  const kind = classifyInstruction(e.instruction);
  // A position we rug-SL-exited stays OPEN on the leader's side (rug-SL is our independent exit). Suppress
  // re-opening it on the leader's next add — we deliberately left; a genuinely new copy only starts on a NEW
  // leader position pubkey (a different key, not in the rug-exited set). Without this, the leader's next
  // AddLiquidity (depositSol>0 on the same, now-untracked, position) would route to 'open' and re-enter the rug.
  if (e.depositSol > 0 && !tracked) return rugExited ? 'ignore' : 'open'; // first capital event on an untracked position → open
  if (!tracked) return 'ignore'; // event on a position we don't mirror → ignore (reconcile/orphan handles it)
  // full close — checked BEFORE withdraw (a close also withdraws). `e.closed` (a decoded PositionClose leg) is
  // the robust signal: under log truncation `instruction` degrades to '(DLMM)' → `kind` is null, so a close
  // would mis-route to resync (Remove+Close) or ignore (standalone close) if we relied on the label alone.
  if (kind === 'close' || e.closed) return 'close';
  if (e.withdrawSol > 0) return 'resync'; // ANY withdrawal → re-sync (shrink): always followed (no-dormant safety)
  // A pure leader ADD (deposit, no withdrawal): grow with the leader only when infinite-add is on; else ignore it
  // (Valhalla "first deposit only"). Removes/closes above are unaffected, so the safety net is never gated.
  if (e.depositSol > 0) return cfg.infiniteAdd ? 'resync' : 'ignore';
  if (kind === 'claim' || e.claimSol > 0) return e.claimSol >= cfg.claimFloorSol ? 'claim' : 'ignore'; // skip a dust claim
  return 'ignore';
}

/** Dependencies for {@link routeWithPending}: the tracked test (already-open + pending-open) plus the routing config. */
export interface RouteWithPendingDeps {
  hasOpen: (pos: string) => boolean;
  isPendingOpen: (pos: string) => boolean;
  cfg: RoutingConfig;
  rugExited: boolean;
}

/** Route an event treating a position as TRACKED if it is already open OR has an open in flight (pending reservation).
 *  This is the exact tracked test the brain uses so a follow-up add during a multi-tx open window routes to resync/
 *  ignore instead of a duplicate open. Pure (no I/O) → unit-testable against real {@link classifyEventAction}. */
export function routeWithPending(e: DetectedEvent, deps: RouteWithPendingDeps): EventAction {
  const tracked = deps.hasOpen(e.position) || deps.isPendingOpen(e.position);
  return classifyEventAction(e, tracked, deps.cfg, deps.rugExited);
}
