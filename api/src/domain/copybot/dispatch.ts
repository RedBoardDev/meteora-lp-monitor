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

export function classifyEventAction(e: DetectedEvent, tracked: boolean): EventAction {
  const kind = classifyInstruction(e.instruction);
  if (e.depositSol > 0 && !tracked) return 'open'; // first capital event on an untracked position → open
  if (!tracked) return 'ignore'; // event on a position we don't mirror → ignore (reconcile/orphan handles it)
  if (e.depositSol > 0) return 'resync'; // deposit on a tracked position → re-sync to target
  if (kind === 'close') return 'close'; // full close — checked BEFORE withdraw (a close also withdraws)
  if (e.withdrawSol > 0) return 'resync'; // partial withdrawal → re-sync to target
  if (kind === 'claim' || e.claimSol > 0) return 'claim'; // fee claim (never a close)
  return 'ignore';
}
