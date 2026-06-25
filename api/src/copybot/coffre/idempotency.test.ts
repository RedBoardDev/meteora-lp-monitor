import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '@/infrastructure/persistence/database';
import { executions } from '@/infrastructure/persistence/schema';
import { claimExecution } from './idempotency';

// Integration: requires local Postgres (:5435).
const URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const CID = '__test_idem_cmd__';
const db = openDatabase(URL);
const clean = (): Promise<unknown> => db.delete(executions).where(eq(executions.commandId, CID));

beforeAll(async () => {
  await clean();
});
afterAll(async () => {
  await clean();
});

// These cases run in order on a shared commandId — they walk the execution state machine on purpose.
describe('claimExecution — idempotency claim with failed-retry (integration)', () => {
  it('fresh command → claimed (true)', async () => {
    expect(await claimExecution(db, CID, 'ek', 999, 1)).toBe(true);
  });

  it('same command already claimed → duplicate (false, no double-sign)', async () => {
    // WHY: the executions row guarantees one command = one signature; a re-delivery must not double-sign.
    expect(await claimExecution(db, CID, 'ek', 999, 2)).toBe(false);
  });

  it('a landed command is never re-claimed (false)', async () => {
    await db.update(executions).set({ state: 'landed' }).where(eq(executions.commandId, CID));
    expect(await claimExecution(db, CID, 'ek', 999, 3)).toBe(false);
  });

  it('a FAILED command CAN be re-claimed → retry (true) and goes back to claimed', async () => {
    // WHY: a failed close must be retryable by the reconcile re-publish; otherwise the position stays dormant.
    await db.update(executions).set({ state: 'failed' }).where(eq(executions.commandId, CID));
    expect(await claimExecution(db, CID, 'ek', 999, 4)).toBe(true);
    const row = await db.select().from(executions).where(eq(executions.commandId, CID));
    expect(row[0]?.state).toBe('claimed');
  });
});
