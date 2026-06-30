/**
 * Copy-bot · activity journal — Postgres adapter (`copy_journal`). Shared by BOTH processes; `process` is bound
 * once per instance so call sites stay terse. Implements the pure `Journal` port (domain/copybot/journal.ts).
 *
 * P1 SHIM (SPEC §8): `record()` is now a THIN ADAPTER over a `CopyEvents` instance. Every legacy `JournalEntry`
 * is mapped to a `CopyEvent` (its `code` resolved from the verbatim `reason` via `resolveLegacyReason`, else the
 * deterministic `FALLBACK_CODE`) and persisted through `EventStore` — so every row back-fills the new tenant /
 * correlation / observability columns BEFORE any call-site rewrite (that is P2). The existing DB row shape and the
 * existing stdout line are PRESERVED (legacy `severity` still governs, and the same one formatted line is emitted
 * once), so the journal-store tests stay green.
 *
 * FAIL-SAFE by design: `record()` NEVER throws. A journal write is observability, not the bot's job — a DB hiccup
 * must never break the hot path nor cause a missed open/close (the cardinal sin). On failure we log loud (Rule 11)
 * and swallow. Call sites fire-and-forget (do not await) so zero latency is added to the ≤3s copy budget.
 */
import type { Logger } from 'pino';
import { formatJournalLine, type Journal, type JournalEntry, type JournalProcess, severityFor, validationWarning } from '@/domain/copybot/journal';
import { CODE_REGISTRY, FALLBACK_CODE, resolveLegacyReason } from '@/domain/copybot/observability/codes';
import type { CopyEvent } from '@/domain/copybot/observability/event';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { CopyEvents } from './observability/copy-events';
import { EventStore } from './observability/event-store';

type Db = ReturnType<typeof openDatabase>;

/** The tenant id used while the bot is mono-user (env-fixed leader/owner). One named const, not a magic string. */
export const SYSTEM_USER_ID = 'system';

/**
 * The COPY wallet on a `JournalEntry` is bound per-instance (it is not on the legacy entry shape). Until the boot
 * passes it (and during the integration tests that construct the store with 3 args), it defaults to empty so the
 * back-filled `wallet` column is a stable, non-null sentinel rather than a per-call guess.
 */
const UNKNOWN_WALLET = '';

export class CopyJournalStore implements Journal {
  private readonly events: CopyEvents;

  constructor(
    db: Db,
    private readonly log: Logger,
    private readonly process: JournalProcess,
    /** The COPY wallet (cfg.ownerPubkey) — bound once, back-fills the `wallet` filter column (SPEC §5, §7). */
    wallet: string = UNKNOWN_WALLET,
    /** Tenant FK → users.id; mono-user PoC = SYSTEM_USER_ID. */
    userId: string = SYSTEM_USER_ID,
  ) {
    // The shim owns its own EventStore + CopyEvents bound to this process's tenant context. (Boot may instead pass
    // a shared CopyEvents via `withEvents` so the brain/coffre keep ONE emitter — see that factory below.)
    this.events = new CopyEvents(new EventStore(db, log), log, { userId, wallet, process });
  }

  /**
   * Construct a store that routes through an ALREADY-BOUND `CopyEvents` (the single emitter the boot builds). The
   * shim then reuses that emitter's tenant context so brain/coffre have exactly one observability seam (SPEC §8).
   */
  static withEvents(events: CopyEvents, log: Logger, process: JournalProcess): CopyJournalStore {
    const store = Object.create(CopyJournalStore.prototype) as CopyJournalStore;
    Object.assign(store as unknown as { events: CopyEvents; log: Logger; process: JournalProcess }, {
      events,
      log,
      process,
    });
    return store;
  }

  async record(entry: JournalEntry): Promise<void> {
    // Surface a missing-reason programming error loudly, but still record the event (never drop activity).
    const warning = validationWarning(entry);
    if (warning) this.log.warn({ entry }, `journal: ${warning}`);

    this.emit(entry); // clean operator-facing line on stdout (the structured mirror; unchanged from before)

    // Route the row through the emitter so the new observability columns back-fill. AWAITED (preserves the legacy
    // contract: callers that await `record()` — and the integration tests — see the row persisted) and NEVER
    // throws (the emitter's durable path swallows + logs loud internally). Production sites fire-and-forget via
    // `void journal.record(...)`, so awaiting here adds no latency to the hot path.
    await this.events.recordAssembledDurable(this.toEvent(entry));
  }

  /**
   * Map a legacy `JournalEntry` to a `CopyEvent`. The `code` is resolved from the verbatim `reason` (alias map →
   * `namespace.<reason>` leaf), else the deterministic `FALLBACK_CODE` (SPEC §8). LEGACY `severity` governs the
   * persisted/logged severity in P1 (NOT the registry severity) so existing rows/tests are byte-for-byte preserved
   * — once call sites emit typed codes in P2, the registry severity takes over. `category` / `audience` / `pinned`
   * are denormalized from the resolved code so the row is self-describing for the future feed read-model.
   */
  private toEvent(entry: JournalEntry): CopyEvent {
    const code = resolveLegacyReason(entry.reason) ?? FALLBACK_CODE;
    const ts = Date.now();
    const correlationId = entry.commandId ?? entry.eventKey;
    return {
      code,
      // Legacy severity governs in P1 (preserves the existing row/log) — NOT CODE_REGISTRY[code].severity.
      severity: entry.severity ?? severityFor(entry.outcome),
      // Denormalized from the resolved code (self-describing for the feed read-model); FALLBACK is internal/non-pinned.
      category: codeFacets(code).category,
      audience: codeFacets(code).audience,
      pinned: codeFacets(code).pinned,
      ts,
      eventTs: ts,
      ctx: this.events.context,
      correlationId,
      commandId: entry.commandId,
      eventKey: entry.eventKey,
      leader: entry.leader,
      pool: entry.pool,
      leaderPosition: entry.leaderPosition,
      ourPosition: entry.ourPosition,
      stage: entry.stage,
      outcome: entry.outcome,
      kind: entry.kind,
      reason: entry.reason,
      leaderSizeSol: entry.leaderSizeSol,
      ourSizeSol: entry.ourSizeSol,
      signature: entry.signature,
      latencyMs: entry.latencyMs,
      adminDetail: entry.detail,
    };
  }

  /** Emit the clean one-line event log at the entry's severity (the readable mirror of the DB journal). */
  private emit(entry: JournalEntry): void {
    const line = formatJournalLine(entry);
    const severity = entry.severity ?? severityFor(entry.outcome);
    if (severity === 'error') this.log.error(line);
    else if (severity === 'warn') this.log.warn(line);
    else this.log.info(line);
  }
}

/** Read a code's denormalized facets (category / audience / pinned) from the registry. Pure local helper. */
function codeFacets(code: CopyEvent['code']): { category: CopyEvent['category']; audience: CopyEvent['audience']; pinned: boolean } {
  const meta = CODE_REGISTRY[code];
  return { category: meta.category, audience: meta.audience, pinned: meta.pinned ?? false };
}
