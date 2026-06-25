/**
 * Copy-bot · vault idempotency claim (pure DB, no SDK). One command = one execution, claimed BEFORE signing.
 *
 * A command is identified by its deterministic `commandId`. The claim INSERTs an `executions` row; on conflict
 * it only re-claims when the existing row is in the terminal `'failed'` state — so a previously FAILED close
 * (or open) can be retried by a later re-publish (the reconcile re-emits the same commandId), while an already
 * `'landed'`/`'claimed'`/`'skipped'` command is rejected as a duplicate. This is what makes failsafe re-closes
 * actually retry instead of being blocked forever by their own failed row.
 */
import { eq } from 'drizzle-orm';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { executions } from '@/infrastructure/persistence/schema';

type Database = ReturnType<typeof openDatabase>;

/**
 * Try to claim a command for execution. Returns `true` when we own it (fresh insert, or retrying a `'failed'`
 * one), `false` when it is a duplicate already handled (landed / in-flight / skipped) → caller must skip.
 */
export async function claimExecution(
  db: Database,
  commandId: string,
  eventKey: string,
  deadlineSlot: number,
  nowMs: number,
): Promise<boolean> {
  const claimed = await db
    .insert(executions)
    .values({ commandId, eventKey, state: 'claimed', deadlineSlot, createdAt: nowMs, updatedAt: nowMs })
    .onConflictDoUpdate({
      target: executions.commandId,
      set: { state: 'claimed', updatedAt: nowMs },
      setWhere: eq(executions.state, 'failed'), // retry ONLY a previously failed command
    })
    .returning({ commandId: executions.commandId });
  return claimed.length > 0;
}
