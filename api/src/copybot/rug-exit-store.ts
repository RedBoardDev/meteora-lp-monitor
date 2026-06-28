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
const RUG_EXITED_KEY = 'copybot.rugExited';

export class RugExitStore {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  /** Load the persisted rug-exited leader positions. Empty (and logged) on absent/corrupt — never throws. */
  async load(): Promise<Set<string>> {
    try {
      const rows = await this.db.select().from(settings).where(eq(settings.key, RUG_EXITED_KEY));
      const raw = rows[0]?.value;
      if (!raw) return new Set();
      const arr: unknown = JSON.parse(raw);
      return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set();
    } catch (e) {
      this.log.warn({ e: (e as Error).message }, 'rug-exit set load failed → starting empty');
      return new Set();
    }
  }

  /** Write-through the full set after a rug-exit. Fail-safe: a write error is logged, never thrown (the in-memory
   *  set still suppresses re-open for the current process; only cross-restart durability is at risk). */
  async save(set: ReadonlySet<string>): Promise<void> {
    try {
      const value = JSON.stringify([...set]);
      await this.db.insert(settings).values({ key: RUG_EXITED_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
    } catch (e) {
      this.log.warn({ e: (e as Error).message }, 'rug-exit set save failed (in-memory still suppresses re-open this run)');
    }
  }
}
