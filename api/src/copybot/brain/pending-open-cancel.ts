/**
 * Copy-bot · BRAIN — PURE helpers for CANCELLING an in-flight multi-tx open when the leader closes first.
 *
 * A MULTI-TX open (two-sided buy→open, Token-2022 create→deposit, wide split) registers its mirror only in a LATER
 * `ev:executed` continuation, seconds after the open handler returned. If the leader CLOSES during that gap, the
 * pending-open stashes must be DROPPED so the continuation never deploys capital into the pool the leader just
 * EXITED (a fast scalp / rug exit). These pure functions map a leader position → the stash keys to drop, and list
 * the leaders that currently have an in-flight open, across the 4 continuation maps — so the brain's cancel logic is
 * unit-testable without booting the engine.
 */

/** The minimal value shapes the cancel logic reads from each pending-open map (the real maps store richer values):
 *  the two-sided / Token-2022-deposit maps stash the originating `DetectedEvent` (`e.position` is the leader), while
 *  the deposit-mirror / reshape-add maps stash `leaderPosition` directly. Both also carry the `pool` (cancel event). */
export interface PendingOpenMaps {
  twoSidedOpens: ReadonlyMap<string, { e: { position: string; pool: string } }>;
  token2022Deposits: ReadonlyMap<string, { e: { position: string; pool: string } }>;
  token2022Mirrors: ReadonlyMap<string, { leaderPosition: string; pool: string }>;
  reshapeAdds: ReadonlyMap<string, { leaderPosition: string; pool: string }>;
}

/** The commandId keys to delete from each map for a given leader position. */
export interface PendingStashKeys {
  twoSidedOpens: string[];
  token2022Deposits: string[];
  token2022Mirrors: string[];
  reshapeAdds: string[];
}

function keysWhere<V>(map: ReadonlyMap<string, V>, matches: (v: V) => boolean): string[] {
  const out: string[] = [];
  for (const [k, v] of map) if (matches(v)) out.push(k);
  return out;
}

/** All stash keys across the 4 maps whose stored leader position === `leaderPosition` (the entries to drop on cancel). */
export function pendingStashesFor(leaderPosition: string, maps: PendingOpenMaps): PendingStashKeys {
  return {
    twoSidedOpens: keysWhere(maps.twoSidedOpens, (v) => v.e.position === leaderPosition),
    token2022Deposits: keysWhere(maps.token2022Deposits, (v) => v.e.position === leaderPosition),
    token2022Mirrors: keysWhere(maps.token2022Mirrors, (v) => v.leaderPosition === leaderPosition),
    reshapeAdds: keysWhere(maps.reshapeAdds, (v) => v.leaderPosition === leaderPosition),
  };
}

/** Total number of stash entries a {@link PendingStashKeys} would drop (observability: how many were cancelled). */
export function stashCount(keys: PendingStashKeys): number {
  return keys.twoSidedOpens.length + keys.token2022Deposits.length + keys.token2022Mirrors.length + keys.reshapeAdds.length;
}

/** Distinct leader positions that currently have an in-flight open, mapped to their pool (for the cancel event). Used
 *  by the reconcile backstop to detect a pending open whose leader account is gone (belt-and-suspenders behind the
 *  close-event-driven handleClose path). */
export function pendingOpenLeaders(maps: PendingOpenMaps): Map<string, string> {
  const out = new Map<string, string>();
  for (const { e } of maps.twoSidedOpens.values()) out.set(e.position, e.pool);
  for (const { e } of maps.token2022Deposits.values()) out.set(e.position, e.pool);
  for (const v of maps.token2022Mirrors.values()) out.set(v.leaderPosition, v.pool);
  for (const v of maps.reshapeAdds.values()) out.set(v.leaderPosition, v.pool);
  return out;
}
