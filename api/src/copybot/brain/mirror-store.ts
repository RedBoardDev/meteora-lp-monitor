/**
 * Copy-bot · brain — persistence of copied positions (`copy_positions`). SOURCE OF TRUTH that survives
 * restarts: at boot, the brain reloads the open mirrors → the failsafe can close those whose leader closed
 * during the downtime (anti DORMANT position). Write-through at open/close.
 */
import { eq } from 'drizzle-orm';
import { openDatabase } from '@/infrastructure/persistence/database';
import { copyPositions } from '@/infrastructure/persistence/schema';
import type { Mirror } from './mirror-registry';

type Db = ReturnType<typeof openDatabase>;

export class MirrorStore {
  constructor(private readonly db: Db) {}

  async saveOpen(m: Mirror): Promise<void> {
    await this.db
      .insert(copyPositions)
      .values({
        leaderPosition: m.leaderPosition,
        ourPosition: m.ourPosition,
        pool: m.pool,
        nonSolSymbol: m.nonSolSymbol,
        sizeSol: m.sizeSol,
        lowerBin: m.lowerBin,
        upperBin: m.upperBin,
        status: 'open',
        openedAt: m.openedAt,
        closedAt: null,
      })
      .onConflictDoNothing({ target: copyPositions.leaderPosition });
  }

  /** Persist the new SOL size after a proportional add/remove (so the effective ratio survives a restart). */
  async updateSize(leaderPosition: string, sizeSol: number): Promise<void> {
    await this.db.update(copyPositions).set({ sizeSol }).where(eq(copyPositions.leaderPosition, leaderPosition));
  }

  async markClosed(leaderPosition: string): Promise<void> {
    await this.db
      .update(copyPositions)
      .set({ status: 'closed', closedAt: Date.now() })
      .where(eq(copyPositions.leaderPosition, leaderPosition));
  }

  /** Still-open mirrors — reloaded at boot to never lose a position (no-dormant). */
  async loadOpen(): Promise<Mirror[]> {
    const rows = await this.db.select().from(copyPositions).where(eq(copyPositions.status, 'open'));
    return rows.map((r) => ({
      leaderPosition: r.leaderPosition,
      ourPosition: r.ourPosition,
      pool: r.pool,
      nonSolSymbol: r.nonSolSymbol,
      sizeSol: r.sizeSol,
      lowerBin: r.lowerBin,
      upperBin: r.upperBin,
      openedAt: r.openedAt,
      status: 'open' as const,
    }));
  }
}
