import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '@/infrastructure/persistence/database';
import { settings } from '@/infrastructure/persistence/schema';
import { RugExitStore } from './rug-exit-store';

// Integration: requires local Postgres (:5435).
const URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const KEY = 'copybot.rugExited';
const PENDING_KEY = 'copybot.rugExitPending';
const db = openDatabase(URL);
const log = pino({ level: 'silent' });
const store = new RugExitStore(db, log);

beforeAll(async () => {
  await db.delete(settings).where(eq(settings.key, KEY));
  await db.delete(settings).where(eq(settings.key, PENDING_KEY));
});
afterAll(async () => {
  await db.delete(settings).where(eq(settings.key, KEY));
  await db.delete(settings).where(eq(settings.key, PENDING_KEY));
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

describe('RugExitStore — durable rug-exit-PENDING set (retry a failed rug-SL close across a restart)', () => {
  it('an unseeded pending store loads an empty set', async () => {
    expect((await store.loadPending()).size).toBe(0);
  });

  it('savePending → a FRESH store (restart simulation) reloads the same set — the re-close retry survives a restart', async () => {
    // WHY: rug-SL is OUR independent crash exit; if its close failed to land and the process restarts, the pending
    // retry must persist so the reconcile keeps re-closing the position until it is confirmed gone (never-miss-close).
    await store.savePending(new Set(['OUR_A', 'OUR_B']));
    const reloaded = await new RugExitStore(openDatabase(URL), log).loadPending();
    expect([...reloaded].sort()).toEqual(['OUR_A', 'OUR_B']);
  });

  it('pending set is INDEPENDENT of the re-open-suppression set (distinct settings keys)', async () => {
    // WHY: rugExited (LEADER positions, suppress RE-OPEN) and rugExitPending (OUR positions, drive RE-CLOSE) are
    // separate concerns — persisting one must never clobber the other.
    await store.save(new Set(['LEADER_X']));
    await store.savePending(new Set(['OUR_X']));
    expect([...(await store.load())]).toEqual(['LEADER_X']);
    expect([...(await store.loadPending())]).toEqual(['OUR_X']);
  });

  it('a corrupt pending blob loads as empty (fail-safe, never throws)', async () => {
    await db.insert(settings).values({ key: PENDING_KEY, value: '}{not json' }).onConflictDoUpdate({ target: settings.key, set: { value: '}{not json' } });
    expect((await store.loadPending()).size).toBe(0);
  });
});
