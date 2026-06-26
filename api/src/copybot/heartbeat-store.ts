/**
 * Copy-bot · heartbeat persistence (`copybot_status`, one row per process). The process upserts its row on an
 * interval; the web reads `ts` freshness → online/offline (domain/copybot/status.ts) and renders `detail`.
 *
 * FAIL-SAFE: `beat()` never throws — a status write is observability, it must never crash or stall the bot.
 */
import type { Logger } from 'pino';
import type { StatusProcess } from '@/domain/copybot/status';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { copybotStatus } from '@/infrastructure/persistence/schema';

type Db = ReturnType<typeof openDatabase>;

export class HeartbeatStore {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly process: StatusProcess,
  ) {}

  /** Upsert this process's heartbeat (stamped now) + current snapshot. Never throws. */
  async beat(detail: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    try {
      await this.db
        .insert(copybotStatus)
        .values({ process: this.process, ts: now, detail })
        .onConflictDoUpdate({ target: copybotStatus.process, set: { ts: now, detail } });
    } catch (e) {
      this.log.warn({ err: (e as Error).message, process: this.process }, 'heartbeat write failed (non-fatal)');
    }
  }
}
