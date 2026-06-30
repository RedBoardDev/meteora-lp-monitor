/**
 * Copy-bot · observability — `EventStore` persistence (integration; requires local Postgres :5435, like
 * journal-store.test.ts). These tests encode the WHY:
 *  - a persisted row back-fills BOTH the legacy columns AND the new tenant/correlation/observability columns
 *    (SPEC §5) — the whole point of P1 is that every row is now attributable by `WHERE wallet=$1`;
 *  - `persist` NEVER throws on a DB failure and logs loud (the cardinal fail-safe contract);
 *  - the serialized `cause` is folded into `detail.cause` (admin-only, JSON-safe).
 */
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CopyEvent } from '@/domain/copybot/observability/event';
import { openDatabase } from '@/infrastructure/persistence/database';
import { copyJournal } from '@/infrastructure/persistence/schema';
import { EventStore } from './event-store';

const URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const MARKER = '__test_event_store__';
const db = openDatabase(URL);
const noopLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
const clean = (): Promise<unknown> => db.delete(copyJournal).where(eq(copyJournal.eventKey, MARKER));

function event(overrides: Partial<CopyEvent> = {}): CopyEvent {
  const ts = Date.now();
  return {
    code: 'lifecycle.open_confirmed',
    severity: 'info',
    category: 'LIFECYCLE',
    audience: 'feed',
    pinned: false,
    ts,
    eventTs: ts,
    ctx: { userId: 'system', wallet: 'WALLETabc', process: 'brain' },
    correlationId: 'CORR1',
    commandId: 'CORR1',
    eventKey: MARKER,
    stage: 'open',
    outcome: 'confirmed',
    ...overrides,
  };
}

beforeAll(async () => {
  await clean();
});
afterAll(async () => {
  await clean();
});

describe('EventStore — persistence back-fills the new columns (SPEC §5)', () => {
  it('writes both legacy and observability columns from a CopyEvent', async () => {
    await new EventStore(db, noopLog).persistDurable(
      event({ leader: 'LEADER', reason: undefined, adminDetail: { foo: 1 } }),
    );
    const row = (await db.select().from(copyJournal).where(eq(copyJournal.commandId, 'CORR1')))[0]!;
    // legacy columns
    expect(row.process).toBe('brain');
    expect(row.stage).toBe('open');
    expect(row.outcome).toBe('confirmed');
    expect(row.severity).toBe('info');
    expect(row.leader).toBe('LEADER');
    expect(row.detail).toEqual({ foo: 1 });
    // new observability columns
    expect(row.userId).toBe('system');
    expect(row.wallet).toBe('WALLETabc'); // THE filter key
    expect(row.correlationId).toBe('CORR1');
    expect(row.code).toBe('lifecycle.open_confirmed');
    expect(row.category).toBe('LIFECYCLE');
    expect(row.audience).toBe('feed');
    expect(row.pinned).toBe(false);
    expect(row.deliveredAt).toBeNull(); // future external-push outbox state, unused while feed-only
    expect(Number(row.eventTs)).toBeGreaterThan(0);
  });

  it('folds the serialized cause into detail.cause (admin-only, JSON-safe)', async () => {
    await new EventStore(db, noopLog).persistDurable(
      event({ commandId: 'CORR2', correlationId: 'CORR2', cause: { name: 'Error', message: 'x' } }),
    );
    const row = (await db.select().from(copyJournal).where(eq(copyJournal.commandId, 'CORR2')))[0]!;
    expect(row.detail).toEqual({ cause: { name: 'Error', message: 'x' } });
  });
});

describe('EventStore — NEVER throws (the cardinal guarantee)', () => {
  it('swallows a DB write failure and logs loud (the loop guard)', async () => {
    const brokenDb = { insert: () => ({ values: async () => { throw new Error('db down'); } }) } as unknown as ReturnType<typeof openDatabase>;
    const warn = vi.fn();
    const log = { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger;
    // persist() is fire-and-forget; persistDurable() is awaited — both must resolve without throwing.
    await expect(new EventStore(brokenDb, log).persistDurable(event({ commandId: 'CORR3', correlationId: 'CORR3' }))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toContain('journal write failed');
  });
});
