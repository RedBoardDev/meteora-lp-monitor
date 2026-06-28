import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '@/infrastructure/persistence/database';
import { settings } from '@/infrastructure/persistence/schema';
import { RugExitStore } from './rug-exit-store';

// Integration: requires local Postgres (:5435).
const URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const KEY = 'copybot.rugExited';
const db = openDatabase(URL);
const log = pino({ level: 'silent' });
const store = new RugExitStore(db, log);

beforeAll(async () => {
  await db.delete(settings).where(eq(settings.key, KEY));
});
afterAll(async () => {
  await db.delete(settings).where(eq(settings.key, KEY));
});

describe('RugExitStore — durable suppression of re-opening a rug-exited leader position', () => {
  it('an unseeded store loads an empty set', async () => {
    expect((await store.load()).size).toBe(0);
  });

  it('save → a FRESH store (restart simulation) reloads the same set — suppression survives a brain restart', async () => {
    // WHY: without persistence, a restart would drop the rug-exit memory and the leader's next add would re-enter
    // the rugged position. The set must round-trip through the DB.
    await store.save(new Set(['LEADER_A', 'LEADER_B']));
    const reloaded = await new RugExitStore(openDatabase(URL), log).load();
    expect([...reloaded].sort()).toEqual(['LEADER_A', 'LEADER_B']);
  });

  it('save overwrites with the full current set (grow then persist)', async () => {
    const set = await store.load();
    set.add('LEADER_C');
    await store.save(set);
    expect([...(await store.load())].sort()).toEqual(['LEADER_A', 'LEADER_B', 'LEADER_C']);
  });

  it('a corrupt blob loads as empty (fail-safe, never throws)', async () => {
    await db.insert(settings).values({ key: KEY, value: '}{not json' }).onConflictDoUpdate({ target: settings.key, set: { value: '}{not json' } });
    expect((await store.load()).size).toBe(0);
  });
});
