import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOnline } from '@/domain/copybot/status';
import { openDatabase } from '@/infrastructure/persistence/database';
import { copybotStatus } from '@/infrastructure/persistence/schema';
import { HeartbeatStore } from './heartbeat-store';

// Integration: requires local Postgres (:5435).
const URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const PROCESS = 'brain' as const;
const db = openDatabase(URL);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const clean = (): Promise<unknown> => db.delete(copybotStatus).where(eq(copybotStatus.process, PROCESS));

beforeEach(async () => {
  await clean();
});
afterAll(async () => {
  await clean();
});

describe('HeartbeatStore (integration)', () => {
  it('beat upserts one fresh row with the snapshot, readable as online', async () => {
    const store = new HeartbeatStore(db, log, PROCESS);
    await store.beat({ openPositions: 2, exposureSol: 0.6 });

    const rows = await db.select().from(copybotStatus).where(eq(copybotStatus.process, PROCESS));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toEqual({ openPositions: 2, exposureSol: 0.6 });
    expect(isOnline(rows[0]!.ts, Date.now())).toBe(true); // just beat → online
  });

  it('a second beat updates the SAME row (one row per process, never a duplicate)', async () => {
    const store = new HeartbeatStore(db, log, PROCESS);
    await store.beat({ openPositions: 1 });
    await store.beat({ openPositions: 5 });

    const rows = await db.select().from(copybotStatus).where(eq(copybotStatus.process, PROCESS));
    expect(rows).toHaveLength(1); // upsert, not insert
    expect(rows[0]!.detail).toEqual({ openPositions: 5 });
  });

  it('NEVER throws when the DB write fails (a status hiccup must not crash the bot)', async () => {
    const brokenDb = { insert: () => ({ values: () => ({ onConflictDoUpdate: async () => { throw new Error('db down'); } }) }) } as unknown as ReturnType<typeof openDatabase>;
    const warn = vi.fn();
    const store = new HeartbeatStore(brokenDb, { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger, PROCESS);
    await expect(store.beat({ openPositions: 1 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
