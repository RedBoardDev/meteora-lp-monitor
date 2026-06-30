/**
 * Copy-bot · observability — `EventStore` (I/O adapter for `copy_journal`).
 *
 * Persists a `CopyEvent` row carrying BOTH the legacy columns (process/stage/outcome/severity/reason/…) AND the
 * new observability columns (user_id/wallet/correlation_id/event_ts/code/category/audience/pinned). It is a strict
 * SUPERSET of `CopyJournalStore`'s insert — the P1 shims route through here so every journaled row back-fills the
 * tenant/correlation/columns before any call-site rewrite (SPEC §5, §8 P1).
 *
 * CARDINAL CONTRACT (identical to `CopyJournalStore`): a journal write is observability, not the bot's job.
 *  - `persist(e)` is fire-and-forget and NEVER throws — a DB hiccup must not break the hot path nor cause a missed
 *    open/close (the copy-bot's #1 pillar). On its OWN write failure it logs a `system.journal_write_failed`-style
 *    line at error level and swallows (the loop guard, SPEC §6 — a broken journal must not recurse into itself).
 *  - `persistDurable(e)` is the awaited path for `pinned` (critical) events — the caller awaits it so the critical
 *    row is on disk before proceeding — but it STILL never throws (it resolves even when the insert rejects).
 */
import type { Logger } from 'pino';
import { severityFor } from '@/domain/copybot/journal';
import type { CopyEvent } from '@/domain/copybot/observability/event';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { copyJournal } from '@/infrastructure/persistence/schema';

type Db = ReturnType<typeof openDatabase>;

/** The structured-error key logged on a self-write failure — the observability loop guard (SPEC §6, D-7). */
const JOURNAL_WRITE_FAILED = 'system.journal_write_failed';

export class EventStore {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  /** Fire-and-forget persist (the default path). NEVER throws — see the cardinal contract above. */
  persist(e: CopyEvent): void {
    void this.write(e);
  }

  /**
   * Awaited persist for `pinned` (critical) events: the caller awaits so the alert row is durably on disk before
   * proceeding (SPEC §6 user-reaching guarantee). Still never throws — `write` swallows + logs loud internally.
   */
  async persistDurable(e: CopyEvent): Promise<void> {
    await this.write(e);
  }

  /** Build the full row (legacy + new columns) from the event and insert it. Swallows + logs loud on failure. */
  private async write(e: CopyEvent): Promise<void> {
    try {
      await this.db.insert(copyJournal).values({
        // ── legacy columns (unchanged shape — preserves CopyJournalStore's row) ──────────────────────────────
        ts: e.ts,
        process: e.ctx.process,
        stage: e.stage,
        outcome: e.outcome,
        severity: e.severity ?? severityFor(e.outcome),
        reason: e.reason ?? null,
        kind: e.kind ?? null,
        leader: e.leader ?? null,
        pool: e.pool ?? null,
        leaderPosition: e.leaderPosition ?? null,
        ourPosition: e.ourPosition ?? null,
        commandId: e.commandId ?? null,
        eventKey: e.eventKey ?? null,
        leaderSizeSol: e.leaderSizeSol ?? null,
        ourSizeSol: e.ourSizeSol ?? null,
        signature: e.signature ?? null,
        latencyMs: e.latencyMs ?? null,
        // `detail` carries the rich SOL payload; the serialized `cause` is folded into it (SPEC §5).
        detail: detailWithCause(e),
        // ── observability redesign columns (SPEC §5) ────────────────────────────────────────────────────────
        userId: e.ctx.userId,
        wallet: e.ctx.wallet,
        correlationId: e.correlationId ?? null,
        eventTs: e.eventTs,
        code: e.code,
        category: e.category,
        audience: e.audience,
        pinned: e.pinned,
        // `delivered_at` is the future external-push outbox state — always null while feed-only (SPEC §5).
        deliveredAt: null,
      });
    } catch (err) {
      // Loud but non-fatal AND non-recursive: log via pino directly, never re-emit through the (broken) journal
      // (the loop guard, SPEC §6 / D-7). The level is `warn` to match `CODE_REGISTRY['system.journal_write_failed']`
      // (severity 'warn'); the message keeps the legacy "journal write failed" wording so operators (and the
      // journal-store tests that lock this fail-loud contract) see the same signal.
      this.log.warn(
        { err: (err as Error).message, code: e.code, wallet: e.ctx.wallet },
        `${JOURNAL_WRITE_FAILED}: journal write failed (non-fatal)`,
      );
    }
  }
}

/** Merge the event's `adminDetail` with the serialized `cause` (admin-only). Returns null when both are absent. */
function detailWithCause(e: CopyEvent): Record<string, unknown> | null {
  if (e.cause === undefined) return e.adminDetail ?? null;
  return { ...(e.adminDetail ?? {}), cause: e.cause };
}
