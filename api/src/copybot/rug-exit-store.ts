/**
 * Copy-bot · brain — DURABLE set of LEADER positions we rug-SL-EXITED. Rug-SL is our INDEPENDENT crash-exit: it
 * closes our mirror while the leader's position stays open on-chain. This persisted set lets the brain suppress
 * re-opening that position on the leader's next add ACROSS restarts (a fresh process would otherwise see the
 * untracked-but-still-open position and re-enter the rug). Stored as a JSON string[] in the `settings` table — no
 * schema migration. Bounded by the number of distinct rug-exits (a NEW leader open uses a new pubkey, never matched).
 */
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { settings } from '@/infrastructure/persistence/schema';

type Db = ReturnType<typeof openDatabase>;
const RUG_EXITED_KEY = 'copybot.rugExited'; // LEADER positions we rug-exited → suppress RE-OPEN across restart
const RUG_EXIT_PENDING_KEY = 'copybot.rugExitPending'; // OUR positions rug-SL-closed but NOT yet confirmed gone → RE-CLOSE across restart

export class RugExitStore {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  /** Load the persisted rug-exited LEADER positions (re-open suppression). Empty (and logged) on absent/corrupt. */
  load(): Promise<Set<string>> {
    return this.loadSet(RUG_EXITED_KEY, 'rug-exit set');
  }

  /** Write-through the full re-open-suppression set after a rug-exit. Fail-safe: a write error is logged, never thrown
   *  (the in-memory set still suppresses re-open for the current process; only cross-restart durability is at risk). */
  save(set: ReadonlySet<string>): Promise<void> {
    return this.saveSet(RUG_EXITED_KEY, set, 'rug-exit set', 'in-memory still suppresses re-open this run');
  }

  /** Load the persisted rug-exit-PENDING OUR positions (rug-SL-closed, awaiting on-chain confirmation → re-close).
   *  Empty (and logged) on absent/corrupt — never throws. Seeded at boot so a failed rug-SL close is retried
   *  across a brain restart (never-miss-close pillar) until the reconcile confirms the position gone. */
  loadPending(): Promise<Set<string>> {
    return this.loadSet(RUG_EXIT_PENDING_KEY, 'rug-exit-pending set');
  }

  /** Write-through the full rug-exit-pending set. Fail-safe: a write error is logged, never thrown (the in-memory
   *  set still drives the re-close this run; only cross-restart durability of the pending retry is at risk). */
  savePending(set: ReadonlySet<string>): Promise<void> {
    return this.saveSet(RUG_EXIT_PENDING_KEY, set, 'rug-exit-pending set', 'in-memory still re-closes this run');
  }

  /** Read a persisted `string[]` from the settings table. Empty on absent/corrupt — never throws (fail-safe). */
  private async loadSet(key: string, label: string): Promise<Set<string>> {
    try {
      const rows = await this.db.select().from(settings).where(eq(settings.key, key));
      const raw = rows[0]?.value;
      if (!raw) return new Set();
      const arr: unknown = JSON.parse(raw);
      return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
    } catch (e) {
      this.log.warn({ e: (e as Error).message }, `${label} load failed → starting empty`);
      return new Set();
    }
  }

  /** Write-through the full set as a JSON `string[]`. Fail-safe: a write error is logged, never thrown. */
  private async saveSet(key: string, set: ReadonlySet<string>, label: string, degradedNote: string): Promise<void> {
    try {
      const value = JSON.stringify([...set]);
      await this.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    } catch (e) {
      this.log.warn({ e: (e as Error).message }, `${label} save failed (${degradedNote})`);
    }
  }
}
