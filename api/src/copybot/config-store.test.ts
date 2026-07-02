import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_DEFAULTS, type CopybotConfig } from '@/domain/copybot/config';
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

    const custom: CopybotConfig = { ...CONFIG_DEFAULTS, user: { ...CONFIG_DEFAULTS.user, twoSidedMode: 'on' } };
    await store.save(custom);
    expect(await store.seedIfAbsent()).toEqual(custom);
  });

  it('save → load round-trips the exact two-tier config', async () => {
    const store = new ConfigStore(db, log);
    const custom: CopybotConfig = {
      user: {
        ...CONFIG_DEFAULTS.user,
        sizing: { tradeRatioPct: 33, maxTradeSizeSol: 0.7, minPositionSizeSol: 0.08, solReserveSol: 0.04, onInsufficient: 'skip' },
        caps: { ...CONFIG_DEFAULTS.user.caps, killSwitchGlobal: true, maxOpenPositions: 2 },
        twoSidedMode: 'shadow',
      },
      leaders: [{ address: 'AnotherLeaderPubkey222222222222222222222222', enabled: false, overrides: { sizing: { tradeRatioPct: 10 } } }],
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
    const bad = { ...CONFIG_DEFAULTS, user: { ...CONFIG_DEFAULTS.user, sizing: { ...CONFIG_DEFAULTS.user.sizing, maxTradeSizeSol: -1 } } } as unknown as CopybotConfig;
    await expect(store.save(bad)).rejects.toThrow();
  });

  it('load on a corrupt blob (no last-good yet) → FAIL-CLOSED with kill switch ON, NOT permissive defaults', async () => {
    const errLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    await db.insert(settings).values({ key: CONFIG_KEY, value: '{not valid json' });
    const store = new ConfigStore(db, errLog);
    const cfg = await store.load();
    // Fail-closed: corruption must never revert to the trading-enabled defaults (would fail OPEN).
    expect(cfg.user.caps.killSwitchGlobal).toBe(true);
    // Proves the fix vs the OLD behavior (old: corrupt → CONFIG_DEFAULTS with killSwitchGlobal:false).
    expect(CONFIG_DEFAULTS.user.caps.killSwitchGlobal).toBe(false);
    expect(cfg).not.toEqual(CONFIG_DEFAULTS);
    expect(errLog.error).toHaveBeenCalledTimes(1);
  });

  it('load caches the last-good config, then a corrupt blob → last-good preserved but kill switch forced ON', async () => {
    const errLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const store = new ConfigStore(db, errLog);
    // 1) a valid custom config loads cleanly and is cached as last-good (kill switch OFF, custom fields set).
    const custom: CopybotConfig = {
      user: { ...CONFIG_DEFAULTS.user, twoSidedMode: 'shadow', caps: { ...CONFIG_DEFAULTS.user.caps, killSwitchGlobal: false, maxOpenPositions: 7 } },
      leaders: [{ address: 'AnotherLeaderPubkey222222222222222222222222', enabled: true, overrides: {} }],
    };
    await store.save(custom);
    expect(await store.load()).toEqual(custom);
    // 2) the blob then becomes corrupt → fail closed to last-good with ONLY the kill switch flipped ON.
    await db.update(settings).set({ value: '{corrupt' }).where(eq(settings.key, CONFIG_KEY));
    const cfg = await store.load();
    expect(cfg.user.caps.killSwitchGlobal).toBe(true);
    expect(cfg.user.twoSidedMode).toBe('shadow'); // other last-good fields preserved
    expect(cfg.user.caps.maxOpenPositions).toBe(7);
    expect(cfg.leaders).toEqual(custom.leaders);
    expect(cfg).toEqual({ ...custom, user: { ...custom.user, caps: { ...custom.user.caps, killSwitchGlobal: true } } });
    expect(errLog.error).toHaveBeenCalledTimes(1);
  });
});
