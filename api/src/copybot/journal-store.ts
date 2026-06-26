/**
 * Copy-bot · activity journal — Postgres adapter (`copy_journal`). Shared by BOTH processes; `process` is bound
 * once per instance so call sites stay terse. Implements the pure `Journal` port (domain/copybot/journal.ts).
 *
 * FAIL-SAFE by design: `record()` NEVER throws. A journal write is observability, not the bot's job — a DB hiccup
 * must never break the hot path nor cause a missed open/close (the cardinal sin). On failure we log loud (Rule 11)
 * and swallow. Call sites fire-and-forget (do not await) so zero latency is added to the ≤3s copy budget.
 */
import type { Logger } from 'pino';
import { type Journal, type JournalEntry, type JournalProcess, severityFor, validationWarning } from '@/domain/copybot/journal';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { copyJournal } from '@/infrastructure/persistence/schema';

type Db = ReturnType<typeof openDatabase>;

export class CopyJournalStore implements Journal {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly process: JournalProcess,
  ) {}

  async record(entry: JournalEntry): Promise<void> {
    // Surface a missing-reason programming error loudly, but still record the event (never drop activity).
    const warning = validationWarning(entry);
    if (warning) this.log.warn({ entry }, `journal: ${warning}`);

    try {
      await this.db.insert(copyJournal).values({
        ts: Date.now(),
        process: this.process,
        stage: entry.stage,
        outcome: entry.outcome,
        severity: entry.severity ?? severityFor(entry.outcome),
        reason: entry.reason ?? null,
        kind: entry.kind ?? null,
        leader: entry.leader ?? null,
        pool: entry.pool ?? null,
        leaderPosition: entry.leaderPosition ?? null,
        ourPosition: entry.ourPosition ?? null,
        commandId: entry.commandId ?? null,
        eventKey: entry.eventKey ?? null,
        leaderSizeSol: entry.leaderSizeSol ?? null,
        ourSizeSol: entry.ourSizeSol ?? null,
        signature: entry.signature ?? null,
        latencyMs: entry.latencyMs ?? null,
        detail: entry.detail ?? null,
      });
    } catch (e) {
      // Loud but non-fatal: the bot keeps running even if its journal is momentarily unavailable.
      this.log.warn({ err: (e as Error).message, stage: entry.stage, outcome: entry.outcome }, 'journal write failed (non-fatal)');
    }
  }
}
