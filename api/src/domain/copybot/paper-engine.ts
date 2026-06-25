/**
 * Copy-bot · P2 — PAPER decision engine (PURE, no I/O). Extracted from `watch-leader.ts` to be 100%
 * testable: given a detected event + the leader position state + the paper ledger, decides the paper
 * action (entry or mirror-close) and updates the ledger. The script now only wires up the I/O (log + DB).
 *
 * Rules:
 *  - PAPER = LIVE only (we don't decide on the replay: a past open is stale, and on cold-start a
 *    1st-add is indistinguishable from an open → we don't pollute the shadow-log).
 *  - ENTRY = 1st capital-bearing event of a position (handles the InitializePosition→AddLiquidity split).
 *  - EXIT = the leader closes a position → mirror-close IF we hold an open mirror (no-miss pillar).
 */
import { classifyInstruction } from '../dlmm';
import { type CapsConfig, type CapsState, checkCaps } from './caps';
import { type EntryConfig, type EntryDecision, decideEntry } from './decision';
import type { DetectedEvent } from './events';
import type { FilterConfig, FilterContext } from './filters';
import type { LeaderPosition } from './leader-position';
import type { PaperPosition, PaperPositionLedger } from './paper-position';

export interface PaperEngineDeps {
  /** true if the event comes from the live stream (ws/poll), false for the replay. */
  isLive: boolean;
  ledger: PaperPositionLedger;
  config: EntryConfig;
  /** entry filter settings (all OFF by default). */
  filterConfig: FilterConfig;
  /** caps + kill-switch (portfolio envelope). */
  caps: CapsConfig;
  /** simulated SOL balance of the follower. */
  followerBalanceSol: number;
  /** injected wall-clock (ms) — caps sliding window + timestamp of our opens. */
  nowMs: number;
}

/** Rebuilds the portfolio state (caps) from the ledger for a candidate on `tokenMint`. */
function buildCapsState(ledger: PaperPositionLedger, tokenMint: string | null): CapsState {
  const open = ledger.openPositions();
  return {
    openPositions: open.length,
    totalExposureSol: open.reduce((s, p) => s + p.sizeSol, 0),
    tokenOpenCount: tokenMint ? open.filter((p) => p.nonSolMint === tokenMint).length : 0,
    openTimestampsMs: ledger.all().map((p) => p.openedAtMs),
  };
}

export type PaperOutcome =
  | { kind: 'entry'; decision: EntryDecision; opened: PaperPosition | null }
  | { kind: 'mirror_close'; closed: PaperPosition }
  | null;

/**
 * Decides the paper action for an event. `leaderPos` = the leader position state AFTER applying the event
 * (or undefined if the event carries no position). Mutates the ledger (open/close of the mirror). Pure and
 * deterministic with respect to (event, leaderPos, ledger state).
 */
export function processPaperEvent(
  event: DetectedEvent,
  leaderPos: LeaderPosition | undefined,
  deps: PaperEngineDeps,
): PaperOutcome {
  if (!deps.isLive || !leaderPos) return null;

  // ENTRY: 1st capital-bearing event of this position.
  if (leaderPos.eventCount === 1 && event.depositSol > 0) {
    // Filter context: the tokens we ALREADY hold open (this position is not yet in the ledger).
    const ctx: FilterContext = {
      openTokenMints: new Set(
        deps.ledger.openPositions().map((p) => p.nonSolMint).filter((m): m is string => m !== null),
      ),
    };
    const decision = decideEntry(event, deps.config, { availableBalanceSol: deps.followerBalanceSol }, {
      ctx,
      config: deps.filterConfig,
    });
    if (decision.outcome === 'skipped') return { kind: 'entry', decision, opened: null };

    // Filters + sizing OK → portfolio envelope (caps + kill-switch). Blocks ⇒ we requalify as a skip.
    const cap = checkCaps(deps.caps, buildCapsState(deps.ledger, event.nonSolMint), decision.sizeSol, deps.nowMs);
    if (cap.action === 'block') {
      return {
        kind: 'entry',
        decision: { outcome: 'skipped', reason: cap.reason, leaderSizeSol: decision.leaderSizeSol },
        opened: null,
      };
    }

    const opened = deps.ledger.openMirror({
      leaderPosition: event.position,
      pool: event.pool,
      nonSolMint: event.nonSolMint,
      nonSolSymbol: event.nonSolSymbol,
      sizeSol: decision.sizeSol,
      openSignature: event.signature,
      blockTime: event.blockTime,
      openedAtMs: deps.nowMs,
    });
    return { kind: 'entry', decision, opened };
  }

  // EXIT: the leader closes a position → mirror-close if we hold an open mirror.
  if (classifyInstruction(event.instruction) === 'close') {
    const closed = deps.ledger.closeMirror(event.position, event.signature, event.blockTime);
    if (closed) return { kind: 'mirror_close', closed };
  }

  return null;
}

/** Fields of a `copy_decisions` row (the `leader` and `decidedAt` are added by the I/O layer). */
export interface PaperDecisionRow {
  signature: string;
  pool: string | null;
  position: string | null;
  eventKind: 'open' | 'close';
  outcome: string;
  skipReason: string | null;
  leaderSizeSol: number;
  ourSizeSol: number | null;
  blockTime: number | null;
}

/** Maps a paper action to the shadow-log row to persist. Pure. */
export function paperDecisionRow(event: DetectedEvent, outcome: NonNullable<PaperOutcome>): PaperDecisionRow {
  const common = {
    signature: event.signature,
    pool: event.pool || null,
    position: event.position || null,
    blockTime: event.blockTime,
  };
  if (outcome.kind === 'entry') {
    const d = outcome.decision;
    return {
      ...common,
      eventKind: 'open',
      outcome: d.outcome,
      skipReason: d.outcome === 'skipped' ? d.reason : null,
      leaderSizeSol: d.leaderSizeSol,
      ourSizeSol: d.outcome === 'skipped' ? null : d.sizeSol,
    };
  }
  // mirror_close: leaderSizeSol = capital withdrawn by the leader; ourSizeSol = size of our mirror.
  return {
    ...common,
    eventKind: 'close',
    outcome: 'mirrored',
    skipReason: null,
    leaderSizeSol: event.withdrawSol,
    ourSizeSol: outcome.closed.sizeSol,
  };
}
