import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_DEFAULTS, type CopybotRuntimeConfig } from '@/domain/copybot/config';
import { openDatabase } from '@/infrastructure/persistence/database';
import { settings } from '@/infrastructure/persistence/schema';
import { ConfigStore } from './config-store';

// Integration: requires local Postgres (:5435).
const URL = process.env.DATABASE_URL ?? 'postgres://meteora:meteora@localhost:5435/meteora';
const CONFIG_KEY = 'copybot.config';
const db = openDatabase(URL);
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const clean = (): Promise<unknown> => db.delete(settings).where(eq(settings.key, CONFIG_KEY));

beforeEach(async () => {
  await clean();
});
afterAll(async () => {
  await clean();
});

describe('ConfigStore (integration)', () => {
  it('seedIfAbsent writes defaults once, then never overwrites an existing config', async () => {
    const store = new ConfigStore(db, log);
    expect(await store.seedIfAbsent()).toEqual(CONFIG_DEFAULTS);

    // mutate, then re-seed: the existing config must survive (seed is first-boot only).
    const custom = { ...CONFIG_DEFAULTS, twoSidedMode: 'on' as const };
    await store.save(custom);
    expect(await store.seedIfAbsent()).toEqual(custom);
  });

  it('save → load round-trips the exact config', async () => {
    const store = new ConfigStore(db, log);
    const custom: CopybotRuntimeConfig = {
      leader: 'AnotherLeaderPubkey222222222222222222222222',
      sizing: { tradeRatioPct: 33, maxTradeSizeSol: 0.7, minPositionSizeSol: 0.08, solReserveSol: 0.04, onInsufficient: 'skip' },
      caps: { ...CONFIG_DEFAULTS.caps, killSwitchGlobal: true, maxOpenPositions: 2 },
      twoSidedMode: 'shadow',
    };
    await store.save(custom);
    expect(await store.load()).toEqual(custom);
  });

  it('load on an empty table → defaults (fail-safe, no throw)', async () => {
    const store = new ConfigStore(db, log);
    expect(await store.load()).toEqual(CONFIG_DEFAULTS);
  });

  it('save throws on an invalid config (the web caller must never persist junk)', async () => {
    const store = new ConfigStore(db, log);
    const bad = { ...CONFIG_DEFAULTS, sizing: { ...CONFIG_DEFAULTS.sizing, maxTradeSizeSol: -1 } } as unknown as CopybotRuntimeConfig;
    await expect(store.save(bad)).rejects.toThrow();
  });

  it('load on a corrupt stored blob → defaults AND logs an error (corruption never silent)', async () => {
    const errLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    await db.insert(settings).values({ key: CONFIG_KEY, value: '{not valid json' });
    const store = new ConfigStore(db, errLog);
    expect(await store.load()).toEqual(CONFIG_DEFAULTS);
    expect(errLog.error).toHaveBeenCalledTimes(1);
  });
});
