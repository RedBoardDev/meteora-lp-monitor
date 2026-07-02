/**
 * Copy-bot · Phase 1.2 — robust detection core (PURE, testable, no I/O).
 *
 * "We NEVER miss an event" model (the project's pillar — missing an open and especially a close = forbidden):
 *   - the WS is only a low-latency TRIGGER (`onWsSignature`);
 *   - the cursor POLL (`poll`) is the completeness GUARANTEE: it (re)lists ALL signatures since
 *     the cursor contiguously, so nothing between two passes can be skipped;
 *   - dedup by signature (`seen`) avoids any duplicate when WS and poll overlap.
 *
 * Key invariant: ONLY the poll advances the cursor (contiguous sweep). The WS merely emits events earlier
 * that the poll will re-cover anyway — so it can never "punch a hole" in the poll's coverage.
 */

// `DetectedEvent` is a DOMAIN type (shared with the P2 brain) → defined in the domain, re-exported here
// for the existing P1 consumers (watch-leader, classify-dlmm-tx, tests).
import type { DetectedEvent } from './events';
export type { DetectedEvent };

export interface SigInfo {
  signature: string;
}

export type EventSource = 'replay' | 'ws' | 'poll';

/** Outcome of classifying a batch. A sig is in AT MOST one set; a resolved NON-DLMM tx is in NEITHER. */
export interface ClassifyResult {
  /** sig → DetectedEvent for DLMM tx ONLY. */
  events: Map<string, DetectedEvent>;
  /** Sigs whose transaction could NOT be fetched (still null after the retry loop — the WS outran the RPC). */
  unresolved: Set<string>;
}

export interface DetectorDeps {
  /** NEW signatures (newest → oldest) since `untilSig`, contiguous (full pagination).
   *  `untilSig === undefined` = cold start → return only the recent history (bounded). */
  listSignaturesSince(untilSig: string | undefined): Promise<SigInfo[]>;
  /** Decodes/values a batch of signatures (any order) → DLMM `events` + the `unresolved` (null-tx) sigs. */
  classify(signatures: string[]): Promise<ClassifyResult>;
  /** Called once per fresh DLMM event, in chronological order (display). */
  onEvent(event: DetectedEvent, source: EventSource): void;
  /** (optional) Persists fresh events BEFORE committing the cursor. A failure → rollback + retry on the
   *  next poll, so the audit log NEVER loses an event (especially a close). Must be idempotent. */
  persist?(events: DetectedEvent[], source: EventSource): Promise<void>;
  /** (optional) A sig was force-past after exhausting `UNRESOLVED_MAX_RETRIES` — the caller emits a LOUD/pinned
   *  observability event ("a leader signature was never resolved — possible missed event; reconcile covers closes"). */
  onGap?(signature: string, attempts: number): void;
}

/** How many polls we re-list an unresolved (null-tx) sig before accepting a LOUD gap (~2 min at a 15s poll). */
const UNRESOLVED_MAX_RETRIES = 8;

export class LeaderDetector {
  private readonly seen = new Set<string>();
  /** Sigs reserved by an IN-FLIGHT classify (WS or poll). While non-empty, the cursor must NOT advance past them:
   *  a concurrent classify may un-reserve one, and a cursor already ahead would skip it forever (the WS/poll race). */
  private readonly inFlight = new Set<string>();
  /** sig → number of polls it has come back unresolved. Bounded retry before a LOUD gap (Option A). */
  private readonly pendingUnresolved = new Map<string, number>();
  /** Single-flight guard: a poll already running → the next tick is skipped (the interval no longer stacks). */
  private polling = false;
  private cursor: string | undefined;

  constructor(
    private readonly deps: DetectorDeps,
    private readonly seenMax = 5000,
  ) {}

  /** The poll cursor (newest contiguously covered signature). Exposed for tests/diagnostics. */
  get cursorSignature(): string | undefined {
    return this.cursor;
  }

  /**
   * Ingests a batch of signatures (newest → oldest), emits the FRESH DLMM events in chronological
   * order, deduped via `seen`. `advanceCursor` is only true for contiguous sweeps (replay/poll),
   * never for the WS (which doesn't necessarily cover contiguously).
   */
  async ingest(sigInfosNewestFirst: SigInfo[], source: EventSource, advanceCursor: boolean): Promise<void> {
    const newest = sigInfosNewestFirst[0]?.signature;
    if (newest === undefined) return;
    const freshNewestFirst = sigInfosNewestFirst.filter((s) => !this.seen.has(s.signature));

    if (freshNewestFirst.length === 0) {
      // Nothing fresh (all committed or reserved in-flight). The sweep is contiguous up to `newest`, but we may
      // only advance if NO concurrent classify still holds a reservation — otherwise it could un-reserve a sig
      // the advanced cursor would then skip forever (the WS/poll race). `false` = nothing was retried this pass.
      this.maybeAdvanceCursor(advanceCursor, newest, false);
      return;
    }

    // We "reserve" the fresh ones BEFORE the async classify so a concurrent call (WS during a poll) doesn't
    // pick them up again — in BOTH `seen` (dedup) and `inFlight` (the cursor must not pass an in-flight sig).
    // BUT if classify fails, we ROLLBACK the reservation: NEVER missing an event is better than a possible
    // duplicate (which will be deduped downstream anyway).
    for (const s of freshNewestFirst) {
      this.markSeen(s.signature);
      this.inFlight.add(s.signature);
    }

    const freshChronological = freshNewestFirst.map((s) => s.signature).reverse();
    let detected: DetectedEvent[];
    let unresolved: Set<string>;
    try {
      const result = await this.deps.classify(freshChronological);
      unresolved = result.unresolved;
      // Sort by blockTime: the signature order returned by the RPC is not strictly monotonic in
      // time, so we order the emission (and persistence) by the tx's real timestamp.
      detected = freshChronological
        .map((s) => result.events.get(s))
        .filter((e): e is DetectedEvent => e !== undefined)
        .sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
      // Persist BEFORE committing: if the log fails, we rollback and the next poll retries.
      if (this.deps.persist && detected.length > 0) await this.deps.persist(detected, source);
    } catch (err) {
      for (const s of freshNewestFirst) {
        this.seen.delete(s.signature); // rollback → retried on the next poll
        this.inFlight.delete(s.signature);
      }
      throw err; // do NOT advance the cursor: the window remains to be re-swept
    }

    // This batch's classify resolved → release its in-flight reservation.
    for (const s of freshNewestFirst) this.inFlight.delete(s.signature);

    // NO-MISS guarantee, per sig in this batch:
    //  - emitted (DLMM) or resolved non-DLMM → COMMITTED: keep `seen`, clear any retry counter.
    //  - unresolved (null tx: the WS raced ahead of tx availability) → un-reserve so the poll re-lists it, up
    //    to `UNRESOLVED_MAX_RETRIES`; beyond that, FORCE-PAST it (keep `seen`, never re-listed) and fire a LOUD
    //    gap signal. Keeping it in `seen` while it is being retried would let the contiguous poll skip it FOREVER.
    const emitted = new Set(detected.map((e) => e.signature));
    let retriedThisPass = false; // a sig un-reserved for retry ⇒ the window is NOT fully covered ⇒ hold the cursor
    for (const s of freshNewestFirst) {
      const sig = s.signature;
      if (emitted.has(sig)) {
        this.pendingUnresolved.delete(sig);
        continue;
      }
      if (unresolved.has(sig)) {
        const attempts = (this.pendingUnresolved.get(sig) ?? 0) + 1;
        if (attempts < UNRESOLVED_MAX_RETRIES) {
          this.pendingUnresolved.set(sig, attempts);
          this.seen.delete(sig); // un-reserve → the next poll re-lists and retries
          retriedThisPass = true;
        } else {
          this.deps.onGap?.(sig, attempts); // exhausted → accept a LOUD gap; keep `seen` so it is never re-listed
          this.pendingUnresolved.delete(sig);
        }
        continue;
      }
      this.pendingUnresolved.delete(sig); // resolved non-DLMM → committed
    }

    this.maybeAdvanceCursor(advanceCursor, newest, retriedThisPass);
    for (const event of detected) this.deps.onEvent(event, source);
  }

  /**
   * Advance the cursor to `newest` ONLY when the window is provably, fully covered: the caller is a contiguous
   * sweep (`advanceCursor`), NO sig is still reserved in-flight (a concurrent classify could un-reserve one), and
   * NOTHING was un-reserved for retry this pass. Otherwise leave the cursor behind → the next poll re-lists the
   * window (`seen` dedups the committed ones; the unresolved ones get retried). This is the critical no-miss rule.
   */
  private maybeAdvanceCursor(advanceCursor: boolean, newest: string, retriedThisPass: boolean): void {
    if (advanceCursor && this.inFlight.size === 0 && !retriedThisPass) this.cursor = newest;
  }

  /** The backstop: lists everything since the cursor and ingests it (advances the cursor). On a cold start
   *  (undefined cursor), pass `source='replay'` to label the startup history. Single-flight: a poll already
   *  running → this tick is skipped (the brain's `setInterval` no longer stacks concurrent sweeps). */
  async poll(source: EventSource = 'poll'): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const sigs = await this.deps.listSignaturesSince(this.cursor);
      await this.ingest(sigs, source, true);
    } finally {
      this.polling = false;
    }
  }

  /** WS trigger: emits a signature early, without advancing the cursor (the poll will re-cover it). */
  async onWsSignature(signature: string): Promise<void> {
    await this.ingest([{ signature }], 'ws', false);
  }

  private markSeen(signature: string): void {
    if (this.seen.has(signature)) return;
    this.seen.add(signature);
    if (this.seen.size > this.seenMax) {
      const oldest = this.seen.values().next().value; // Set keeps insertion order
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}
