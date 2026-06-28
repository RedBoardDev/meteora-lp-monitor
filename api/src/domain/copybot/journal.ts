/**
 * Copy-bot · activity journal — PURE taxonomy + port (no I/O, no DB).
 *
 * The journal is the append-only, lifecycle-wide record of every meaningful action the bot takes, across BOTH
 * processes (brain = detect/decide/build/publish, coffre = verify/sign/land). It is the source of truth the web
 * reads to render the activity feed. It is intentionally SEPARATE from `pino` stdout logging (debug noise) and
 * from `copy_positions` (current position state): this captures the WHY/outcome of each step, not just the state.
 *
 * Taxonomy is compositional — a journal entry is `(stage, outcome[, reason])` — so adding a pipeline stage does not
 * multiply a flat event enum. The journal OWNS three small closed enums (stage / outcome / severity); the `reason`
 * is the producer's own functional code (decision.reason, cap.reason, filter verdict, Wall B), stored VERBATIM —
 * we never re-translate an identifier (project standard).
 */

/** The leader DLMM action / sign kind this entry relates to (mirrors the SignRequest `kind`). */
export const JOURNAL_KINDS = ['open', 'add', 'remove', 'close', 'claim', 'sell', 'buy'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** Pipeline stage of the bot that produced the entry. */
export const JOURNAL_STAGES = [
  'detect', // a leader event was observed/routed
  'open', // open a copied position (incl. the two-sided buy sub-step)
  'reshape', // proportional add/remove to track the leader's bin shape
  'close', // close a copied position
  'sell', // residual token → SOL sell after a close
  'sweep', // dormant non-SOL dust sweep
  'failsafe', // safety re-close / orphan auto-close (anti-dormant)
  'sign', // vault verify → sign → land
  'recover', // vault boot pending-recovery
] as const;
export type JournalStage = (typeof JOURNAL_STAGES)[number];

/** What happened to that stage. */
export const JOURNAL_OUTCOMES = [
  'detected', // observed, no action yet (detect/sweep)
  'published', // intent built + published to the bus (brain)
  'landed', // signed + landed on-chain (coffre)
  'confirmed', // verified on-chain (e.g. close confirmed by reconcile / ev:executed)
  'skipped', // deliberately not copied (our decision: below floor, non-SOL, filtered, unbuyable…)
  'blocked', // an entry cap / kill-switch prevented an otherwise-valid copy
  'failed', // an attempt errored out (build/publish or sign/land after retries)
  'rejected', // the vault refused the command (Wall B / staleness / duplicate)
  'noop', // nothing to do (already in sync)
] as const;
export type JournalOutcome = (typeof JOURNAL_OUTCOMES)[number];

/** Severity for UI coloring + alerting. Derived from the outcome by default (see `severityFor`), overridable. */
export const JOURNAL_SEVERITIES = ['info', 'warn', 'error'] as const;
export type JournalSeverity = (typeof JOURNAL_SEVERITIES)[number];

/** Which process emitted the entry (bound once per adapter instance). */
export const JOURNAL_PROCESSES = ['brain', 'coffre'] as const;
export type JournalProcess = (typeof JOURNAL_PROCESSES)[number];

/**
 * A single journal entry as seen by a call site. `process`, `ts` and `severity` are filled by the adapter
 * (process is bound per-instance; ts is stamped at record time; severity defaults from the outcome).
 */
export interface JournalEntry {
  stage: JournalStage;
  outcome: JournalOutcome;
  /** Override the default severity (e.g. a `published` reshape that was only partial → 'warn'). */
  severity?: JournalSeverity;
  /** Producer's functional reason code, verbatim (required for skipped/blocked/failed/rejected — see `requiresReason`). */
  reason?: string;
  kind?: JournalKind;
  leader?: string;
  pool?: string;
  /** The leader position pubkey — correlates the whole lifecycle of one mirrored position. */
  leaderPosition?: string;
  /** Our copied position pubkey. */
  ourPosition?: string;
  /** Idempotency / bus correlation (executions.command_id). */
  commandId?: string;
  /** Detection correlation (leader:pool:event:slot:txSig). */
  eventKey?: string;
  leaderSizeSol?: number;
  ourSizeSol?: number;
  /** On-chain tx signature (landed events) or the leader trigger signature (detect). */
  signature?: string;
  /** Latency in ms (build+publish on the brain, sign+land on the coffre) — the speed pillar. */
  latencyMs?: number;
  /** Free-form structured long tail (bin ranges, fidelity metrics, filter sub-code…). */
  detail?: Record<string, unknown>;
}

/** The port: brain and coffre depend on THIS, not on the DB adapter. */
export interface Journal {
  record(entry: JournalEntry): Promise<void>;
}

/** Outcomes that denote a non-progressing result whose cause MUST be recorded (so the feed always explains them). */
const REASON_REQUIRED: ReadonlySet<JournalOutcome> = new Set<JournalOutcome>(['skipped', 'blocked', 'failed', 'rejected']);

/** Default severity for an outcome. Invariant the UI/alerting rely on: failed/rejected are ALWAYS surfaced as error. */
export function severityFor(outcome: JournalOutcome): JournalSeverity {
  if (outcome === 'failed' || outcome === 'rejected') return 'error';
  if (outcome === 'blocked') return 'warn';
  return 'info';
}

/** Whether an entry with this outcome must carry a `reason` (skip/block/fail/reject always explain themselves). */
export function requiresReason(outcome: JournalOutcome): boolean {
  return REASON_REQUIRED.has(outcome);
}

/**
 * Loud-but-non-fatal validation: returns a human message when the entry violates the reason invariant, else null.
 * The adapter logs the message (fail loud) yet still records the entry (never drop an event) — see CopyJournalStore.
 */
export function validationWarning(entry: JournalEntry): string | null {
  if (requiresReason(entry.outcome) && (entry.reason === undefined || entry.reason === '')) {
    return `journal entry stage=${entry.stage} outcome=${entry.outcome} is missing a required reason`;
  }
  return null;
}


/**
 * Default pipeline stage for a leader/sign kind — used by the generic publish-time journaling so every published
 * intent is recorded without per-call-site stage plumbing. Context-specific publishes (a failsafe/orphan re-close,
 * a reshape-funding buy) override the stage explicitly at the call site.
 */
export function stageForKind(kind: JournalKind): JournalStage {
  switch (kind) {
    case 'open':
    case 'buy': // funds a two-sided open's token leg
      return 'open';
    case 'add':
    case 'remove':
      return 'reshape';
    case 'close':
    case 'claim': // fee harvest on the position — close-domain maintenance
      return 'close';
    case 'sell':
      return 'sell';
  }
}


/** Per-outcome icon for the human-readable log line (Valhalla-style). */
const OUTCOME_ICON: Record<JournalOutcome, string> = {
  detected: '👁️',
  published: '📤',
  landed: '🚀',
  confirmed: '✅',
  skipped: '⤳',
  blocked: '🛑',
  failed: '❌',
  rejected: '⛔',
  noop: '·',
};

/** Abbreviate a long pubkey/signature for a readable log line (first 4 + last 4). Pure. */
function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

/**
 * Render a journal entry as ONE clean human-readable log line (the operator-facing event feed). Deterministic +
 * pure; the structured fields live in the DB row, this is the readable stdout mirror — e.g.
 *   `⤳ OPEN skipped (entry_filter) · pool=5rCf…AS6`   ·   `🚀 SIGN landed · close · sig=ab…yz · 1842ms`
 */
export function formatJournalLine(e: JournalEntry): string {
  const fields: string[] = [];
  if (e.kind && e.kind !== e.stage) fields.push(e.kind);
  if (e.ourSizeSol !== undefined) fields.push(`${e.ourSizeSol} SOL`);
  if (e.pool) fields.push(`pool=${short(e.pool)}`);
  if (e.signature) fields.push(`sig=${short(e.signature)}`);
  if (e.latencyMs !== undefined) fields.push(`${e.latencyMs}ms`);
  const reason = e.reason ? ` (${e.reason})` : '';
  const suffix = fields.length ? ` · ${fields.join(' · ')}` : '';
  return `${OUTCOME_ICON[e.outcome]} ${e.stage.toUpperCase()} ${e.outcome}${reason}${suffix}`;
}
