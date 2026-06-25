/**
 * Copy-bot · P2 (J2, brain) — pluggable "brick" contract (PURE, no I/O, no key).
 *
 * Three families (spec 03 §2): filter `(candidate, ctx) → pass | skip(reason)`, exit
 * `(ourPosition, mark) → hold | close(reason)`, sizing `(leaderEvent, followerState) → sizeSol`. This file
 * carries ONLY the shared contract (metadata + enums); each family defines its concrete interface in
 * its own module (cf. `sizing.ts`). Adding a rule = one file + one registration line, zero impact
 * on the rest (extensibility invariant, spec 03 §1-2). The parallel runner / registry will arrive with the
 * filters (P2.3) — we don't build the abstraction while a single brick uses it.
 */

export type BrickFamily = 'sizing' | 'filter' | 'exit';

/** Scope of a setting (spec 03 §2, DECISIONS verification round 2). */
export type BrickScope = 'system' | 'user-global' | 'per-leader';

/** Evaluation cost → places the brick in/out of the runner's critical path (budget ≤3s, spec 07 §6). */
export type SpeedClass = 'instant' | 'cached' | 'external-call';

/** Metadata common to every brick — rendered generically by the settings UI and read by the scheduler. */
export interface BrickMeta {
  readonly id: string;
  readonly family: BrickFamily;
  readonly scope: BrickScope;
  readonly speedClass: SpeedClass;
  readonly defaultEnabled: boolean;
  /** Poll cadence for polled exits (e.g. rug-SL 5s, others 10s); absent = event-driven. */
  readonly pollMs?: number;
}
