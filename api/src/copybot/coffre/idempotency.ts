/**
 * Copy-bot · vault idempotency claim (pure DB, no SDK). One command = one execution, claimed BEFORE signing.
 *
 * A command is identified by its deterministic `commandId`. The claim INSERTs an `executions` row; on conflict
 * it only re-claims when the existing row is in the terminal `'failed'` state — so a previously FAILED close
 * (or open) can be retried by a later re-publish (the reconcile re-emits the same commandId), while an already
 * `'landed'`/`'claimed'`/`'skipped'` command is rejected as a duplicate. This is what makes failsafe re-closes
 * actually retry instead of being blocked forever by their own failed row.
 */
import { eq, inArray } from 'drizzle-orm';
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
  recovering = false,
): Promise<boolean> {
  // Normal flow: re-claim ONLY a terminal 'failed' command (a reconcile re-publish retry); a 'claimed'/'landed'/
  // 'skipped' one is a duplicate → reject (no double-sign on a re-delivered in-flight command).
  // recovering=true (vault boot PENDING-recovery only): ALSO re-claim a stranded 'claimed' — a PRIOR instance
  // claimed it then CRASHED before landing, and the single-consumer is provably dead now (no live claimant), so
  // re-processing is safe. A re-claimed open re-signs its DETERMINISTIC position keypair → if it had already
  // landed, the account exists and the re-attempt fails harmlessly (no double position).
  const reclaimable = recovering ? inArray(executions.state, ['failed', 'claimed']) : eq(executions.state, 'failed');
  const claimed = await db
    .insert(executions)
    .values({ commandId, eventKey, state: 'claimed', deadlineSlot, createdAt: nowMs, updatedAt: nowMs })
    .onConflictDoUpdate({ target: executions.commandId, set: { state: 'claimed', updatedAt: nowMs }, setWhere: reclaimable })
    .returning({ commandId: executions.commandId });
  return claimed.length > 0;
}
