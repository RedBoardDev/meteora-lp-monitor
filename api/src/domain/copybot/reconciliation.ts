/**
 * Copy-bot · P2.5 — reconciliation / failsafe (PURE, no I/O). The on-chain backstop of the no-miss-close pillar:
 * even if we missed or mis-classified the leader's close (the case of a 100%-remove seen as 'remove', or a close out
 * of window), we close OUR mirror as soon as the leader position is confirmed gone on-chain.
 *
 * Sweep A (spec 04 §5 / 15 §5): among our OPEN mirrors, those whose leader position is **confirmed
 * closed** on-chain → to be closed in failsafe. Absolute safety rule: we NEVER act on 'unknown' or
 * 'open' — closing a position wrongly would be serious. The I/O layer provides the state via `getAccountInfo`
 * (closed position account / rent reclaimed ⇒ nonexistent ⇒ 'closed').
 */
import type { PaperDecisionRow } from './paper-engine';
import type { PaperPosition } from './paper-position';

export type LeaderPositionState = 'open' | 'closed' | 'unknown';

/** Translates the result of an on-chain fetch into a state. An RPC error ⇒ 'unknown' (we never close on
 *  doubt); account present ⇒ 'open'; account absent ⇒ 'closed' (rent reclaimed at DLMM close). Pure. */
export function leaderStateFromFetch(accountExists: boolean, errored: boolean): LeaderPositionState {
  if (errored) return 'unknown';
  return accountExists ? 'open' : 'closed';
}

/** Sweep A: our open mirrors whose leader position is CONFIRMED closed → to be closed in failsafe.
 *  'open'/'unknown'/absent from the map ⇒ we don't touch (safety). Pure, generic over any type bearing
 *  `leaderPosition` (PaperPosition on the paper side, Mirror on the brain side). */
export function planFailsafeCloses<T extends { leaderPosition: string }>(
  openMirrors: T[],
  leaderState: Map<string, LeaderPositionState>,
): T[] {
  return openMirrors.filter((m) => leaderState.get(m.leaderPosition) === 'closed');
}

/**
 * AIRTIGHT reconciliation based on ON-CHAIN reality (NEVER trusts the DB status, which can lie
 * if a close failed). Compares OUR wallet's positions actually on-chain to the persisted mapping + the
 * leader positions' state. Guarantees "never a dormant position": a failed close stays detected (our
 * position is still on-chain while the leader has closed → re-close); a successful close is observed
 * (our position has disappeared → mark closed); an untracked position → orphan → alert.
 */
export interface ReconcileInput {
  /** OUR wallet's positions present on-chain per the ENUMERATOR (getAllLbPairPositionsByUser). Used ONLY for
   *  orphan detection — the enumerator can LAG, so it is NOT trusted to conclude a close (see `ourClosed`). */
  ourOnChain: Set<string>;
  /** Tracked positions whose account is DIRECTLY confirmed gone (`getAccountInfo(ourPosition) === null`). This
   *  is the RELIABLE close signal (a per-account read, not the laggy enumerator) → drives markClosed/reClose. */
  ourClosed: Set<string>;
  /** persisted mapping of mirrors still "open" in DB. */
  tracked: Array<{ ourPosition: string; leaderPosition: string }>;
  /** leaderPositions CONFIRMED closed on-chain. */
  leaderClosed: Set<string>;
  /**
   * ourPositions opened too recently to TRUST their on-chain absence (open-grace). A just-opened position is
   * not yet returned by the on-chain enumerator (indexer/confirmation lag), so its absence does NOT mean
   * "closed". These are skipped for markClosed/reClose, BUT stay counted as tracked (never flagged orphan).
   * Without this, a reconcile firing within ~1s of a fresh open reads the not-yet-indexed position as "gone"
   * → markClosed → the mirror is forgotten → DORMANT (the #1-pillar regression we observed live).
   */
  recentlyOpened?: ReadonlySet<string>;
}

export interface ReconcilePlan {
  /** our position is DIRECTLY confirmed gone on-chain (getAccountInfo null) → close succeeded → mark closed in DB. */
  markClosed: string[];
  /** our position is STILL on-chain while the leader has closed → re-close (retry the failed close). */
  reClose: Array<{ ourPosition: string; leaderPosition: string }>;
  /** position on-chain on our side but untracked → we don't close blindly, we alert. */
  orphans: string[];
}

export function planReconcile(input: ReconcileInput): ReconcilePlan {
  const plan: ReconcilePlan = { markClosed: [], reClose: [], orphans: [] };
  const trackedOurs = new Set(input.tracked.map((t) => t.ourPosition));
  const recentlyOpened = input.recentlyOpened ?? new Set<string>();

  for (const t of input.tracked) {
    if (recentlyOpened.has(t.ourPosition)) continue; // open-grace: a fresh open's on-chain state isn't reliable yet
    if (input.ourClosed.has(t.ourPosition)) {
      plan.markClosed.push(t.ourPosition); // DIRECTLY confirmed gone → close confirmed
    } else if (input.leaderClosed.has(t.leaderPosition)) {
      plan.reClose.push(t); // ours still present but leader closed → re-close (retry the failed close)
    }
    // otherwise: ours present + leader open → active mirror, we don't touch.
  }
  // Orphans use the ENUMERATOR vs ALL tracked (incl. recentlyOpened) so a fresh open is never an orphan.
  for (const ours of input.ourOnChain) {
    if (!trackedOurs.has(ours)) plan.orphans.push(ours); // on-chain but untracked → stray position
  }
  return plan;
}

/** Shadow-log row of a failsafe close (no leader close tx → synthetic, idempotent signature). */
export function failsafeRow(mirror: PaperPosition): PaperDecisionRow {
  return {
    signature: `failsafe:${mirror.leaderPosition}`,
    pool: mirror.pool || null,
    position: mirror.leaderPosition,
    eventKind: 'close',
    outcome: 'failsafe_close',
    skipReason: null,
    leaderSizeSol: 0,
    ourSizeSol: mirror.sizeSol,
    blockTime: null,
  };
}
