import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '@/infrastructure/persistence/database';
import { copyPositions } from '@/infrastructure/persistence/schema';
import type { Mirror } from './mirror-registry';
import { MirrorStore } from './mirror-store';

// Integration: requires local Postgres (:5435).
const URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const LP = '__test_mirror_store__';
const mirror: Mirror = { leaderPosition: LP, ourPosition: 'OUR', pool: 'POOL', nonSolSymbol: 'TOK', sizeSol: 0.25, lowerBin: -45, upperBin: -42, openedAt: 1_700_000_000_000, status: 'open' };

const db = openDatabase(URL);
const store = new MirrorStore(db);

beforeAll(async () => {
  await db.delete(copyPositions).where(eq(copyPositions.leaderPosition, LP));
});
afterAll(async () => {
  await db.delete(copyPositions).where(eq(copyPositions.leaderPosition, LP));
});

describe('MirrorStore — no-dormant persistence (integration)', () => {
  it('saveOpen → loadOpen returns the mirror', async () => {
    await store.saveOpen(mirror);
    const open = await store.loadOpen();
    expect(open.find((m) => m.leaderPosition === LP)).toMatchObject({ ourPosition: 'OUR', lowerBin: -45, status: 'open' });
  });

  it('RESTART SIMULATION: a NEW store reloads the open mirror (survives a restart)', async () => {
    const fresh = new MirrorStore(openDatabase(URL)); // ≈ restarted process: no memory
    const open = await fresh.loadOpen();
    expect(open.some((m) => m.leaderPosition === LP)).toBe(true); // no dormant position lost
  });

  it('updateSize persists the new SOL size (the effective ratio survives a restart)', async () => {
    // WHY: after a proportional add/remove the tracked size changes; if it were not persisted, a restart would
    // reload the STALE open size and mis-size future mirror actions.
    await store.updateSize(LP, 0.5);
    const reloaded = (await new MirrorStore(openDatabase(URL)).loadOpen()).find((m) => m.leaderPosition === LP);
    expect(reloaded?.sizeSol).toBe(0.5);
  });

  it('markClosed → loadOpen no longer returns it', async () => {
    await store.markClosed(LP);
    const open = await store.loadOpen();
    expect(open.some((m) => m.leaderPosition === LP)).toBe(false);
  });
});
