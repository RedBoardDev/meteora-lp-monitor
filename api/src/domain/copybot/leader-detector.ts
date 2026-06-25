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

export interface DetectorDeps {
  /** NEW signatures (newest → oldest) since `untilSig`, contiguous (full pagination).
   *  `untilSig === undefined` = cold start → return only the recent history (bounded). */
  listSignaturesSince(untilSig: string | undefined): Promise<SigInfo[]>;
  /** Decodes/values a batch of signatures (any order) → map sig→event for DLMM tx ONLY. */
  classify(signatures: string[]): Promise<Map<string, DetectedEvent>>;
  /** Called once per fresh DLMM event, in chronological order (display). */
  onEvent(event: DetectedEvent, source: EventSource): void;
  /** (optional) Persists fresh events BEFORE committing the cursor. A failure → rollback + retry on the
   *  next poll, so the audit log NEVER loses an event (especially a close). Must be idempotent. */
  persist?(events: DetectedEvent[], source: EventSource): Promise<void>;
}

export class LeaderDetector {
  private readonly seen = new Set<string>();
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
      // Nothing new, but the sweep is contiguous up to `newest` → we can advance the cursor.
      if (advanceCursor) this.cursor = newest;
      return;
    }

    // We "reserve" the fresh ones BEFORE the async classify so a concurrent call (WS during a poll) doesn't
    // pick them up again. BUT if classify fails, we ROLLBACK the reservation: NEVER missing an event
    // is better than a possible duplicate (which will be deduped downstream anyway).
    for (const s of freshNewestFirst) this.markSeen(s.signature);

    const freshChronological = freshNewestFirst.map((s) => s.signature).reverse();
    let detected: DetectedEvent[];
    try {
      const events = await this.deps.classify(freshChronological);
      // Sort by blockTime: the signature order returned by the RPC is not strictly monotonic in
      // time, so we order the emission (and persistence) by the tx's real timestamp.
      detected = freshChronological
        .map((s) => events.get(s))
        .filter((e): e is DetectedEvent => e !== undefined)
        .sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
      // Persist BEFORE committing: if the log fails, we rollback and the next poll retries.
      if (this.deps.persist && detected.length > 0) await this.deps.persist(detected, source);
    } catch (err) {
      for (const s of freshNewestFirst) this.seen.delete(s.signature); // rollback → retried on the next poll
      throw err; // do NOT advance the cursor: the window remains to be re-swept
    }

    // NO-MISS guarantee: a reserved sig that yielded NO event must be UN-reserved. This happens when the WS
    // races ahead of tx availability (classify sees a not-yet-queryable / null tx → no event, no throw): if we
    // kept it in `seen`, the contiguous poll would skip it FOREVER. Un-reserving lets the next poll re-cover it.
    // (A genuine non-DLMM tx is simply re-checked until the cursor advances past it — cheap, never missed.)
    const emitted = new Set(detected.map((e) => e.signature));
    for (const s of freshNewestFirst) if (!emitted.has(s.signature)) this.seen.delete(s.signature);

    if (advanceCursor) this.cursor = newest;
    for (const event of detected) this.deps.onEvent(event, source);
  }

  /** The backstop: lists everything since the cursor and ingests it (advances the cursor). On a cold start
   *  (undefined cursor), pass `source='replay'` to label the startup history. */
  async poll(source: EventSource = 'poll'): Promise<void> {
    const sigs = await this.deps.listSignaturesSince(this.cursor);
    await this.ingest(sigs, source, true);
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
