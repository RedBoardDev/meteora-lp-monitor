/**
 * Copy-bot · observability — the `CopyEvent` model (PURE: no I/O, no SDK, no DB).
 *
 * ONE typed observability RECORD (discriminated by `code`) feeding two channels: a structured admin/console
 * record and a human-readable in-app user feed. This is NOT a throwable Error — events are fire-and-forget
 * observability records, and the journal contract MUST NOT throw (SPEC §0, locked decision 1).
 *
 * SOL-only, everywhere — no USD, no price gateway, no USD fields (SPEC §0, locked decision 2).
 *
 * The pipeline taxonomy (`JournalStage` / `JournalOutcome` / `JournalKind`) and the `severityFor` invariant are
 * REUSED from `../journal` — a `CopyEvent` COMPOSES them, it does not redefine them (SPEC §1).
 */
import type { JournalKind, JournalOutcome, JournalStage } from '../journal';
import type { CopyCode } from './codes';
import type { CopyAudience, CopyCategory, CopySeverity } from './kinds';

// Re-exported from the leaf `./kinds` module so existing importers keep the stable `./event` path.
export type { CopyAudience, CopyCategory, CopySeverity } from './kinds';

/**
 * Bound ONCE per emitter instance (like the `process` binding on the journal store today). Carries tenancy so
 * every row is attributable: `WHERE wallet=$1` yields one user's whole timeline (SPEC §7).
 */
export interface CopyEventContext {
  /** Tenant FK → users.id; mono-user PoC = SYSTEM_USER_ID. */
  userId: string;
  /** The COPY wallet (cfg.ownerPubkey) — THE admin/user filter key. */
  wallet: string;
  /** Which process emitted the event. */
  process: 'brain' | 'coffre';
}

/**
 * i18n-ready structured user message (NOT a pre-joined string) — a future locale layer keys on `titleKey` and
 * re-maps the parts. English-only today (SPEC §1, §9 i18n). Built lazily, only when `audience === 'feed'`.
 */
export interface UserMessage {
  emoji: string;
  /** The event code; a future locale layer keys on this. */
  titleKey: CopyCode;
  /** Already SOL-formatted segments (English today). */
  lineParts: Array<string>;
  links: Array<{ label: string; url: string }>;
}

/**
 * One observability record. `severity` / `category` / `audience` / `pinned` are DENORMALIZED from
 * `CODE_REGISTRY[code]` at assembly time so a persisted row is self-describing on replay (SPEC §1).
 */
export interface CopyEvent {
  /** Canonical identity `namespace.leaf` (registry key) — replaces every ad-hoc reason string. */
  code: CopyCode;
  /** Denormalized from `CODE_REGISTRY[code]`. */
  severity: CopySeverity;
  /** Denormalized from `CODE_REGISTRY[code]`. */
  category: CopyCategory;
  /** Denormalized from `CODE_REGISTRY[code]`. */
  audience: CopyAudience;
  /** Critical-after-retries → surfaced as an alert in the feed (was v1 `mustNotify`). Denormalized from registry. */
  pinned: boolean;
  /** Record time (`Date.now()` in the adapter). */
  ts: number;
  /** Explicit business/observed time — closes the implicit-ts gap (e.g. the on-chain slot time). */
  eventTs: number;
  /** Tenancy (bound once per emitter). */
  ctx: CopyEventContext;
  /** `= commandId ?? eventKey` — threads one lifecycle together AND is the `(correlationId, code)` dedup key. */
  correlationId?: string;
  commandId?: string;
  eventKey?: string;
  leader?: string;
  pool?: string;
  leaderPosition?: string;
  ourPosition?: string;
  /** REUSED from `../journal` (no new copies). */
  stage: JournalStage;
  /** REUSED from `../journal`. */
  outcome: JournalOutcome;
  /** REUSED from `../journal`. */
  kind?: JournalKind;
  /** Verbatim leaf reason (back-compat; "never translate identifiers"). */
  reason?: string;
  leaderSizeSol?: number;
  ourSizeSol?: number;
  signature?: string;
  /** Latency in ms (build+publish on the brain, sign+land on the coffre) — the speed pillar. */
  latencyMs?: number;
  /** Long tail for the admin JSON (== today's `detail`). */
  adminDetail?: Record<string, unknown>;
  /** Built lazily, only when `audience === 'feed'`. */
  userMessage?: UserMessage;
  /** Serialized cause (admin-only) — NOT a live Error (a record must be replayable + JSON-safe). */
  cause?: { name: string; message: string; stack?: string };
}
