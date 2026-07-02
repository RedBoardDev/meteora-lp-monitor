/**
 * Copy-bot · on-chain bench — DB config seed. The bench used to drive the bot via COPYBOT_* env vars (a temporary
 * env-override bridge, now removed); it seeds the SAME effective config directly into the DB `copybot.config` row,
 * which the brain reads on boot via `ConfigStore.seedIfAbsent()` and hot-reloads via `load()`. Overwriting the row is
 * fine here — the bench DB is disposable (never prod), so a clean overwrite each (re)start is the intended reset.
 */
import type { Logger } from 'pino';
import { ConfigStore } from '@/copybot/config-store';
import type { CapsConfig } from '@/domain/copybot/caps';
import { CONFIG_DEFAULTS, type CopybotConfig, type UserSettings } from '@/domain/copybot/config';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { LEADER_TEST } from './env';

type Db = ReturnType<typeof openDatabase>;

// Bench copy-ratio: TRADE_RATIO_PCT=50 → copy half the leader's size (was COPYBOT_TRADE_RATIO_PCT).
export const BENCH_TRADE_RATIO_PCT = 50;
// Bench min position floor: MIN_POSITION_SOL=0.02 → an under-floor copy is SKIPPED (exercises the floor; was
// COPYBOT_MIN_POSITION_SOL). Also the small-size the caps/kill-switch tests rely on.
export const BENCH_MIN_POSITION_SOL = 0.02;
// DUST_TOKEN_RAW=1e6 (≈1 USDC, 6-dec): the two-sided CLASSIFICATION cutoff only — a fresh "spot" open picks up a
// sub-1-USDC token leg from active-bin arb, NOT worth a two-sided buy (wasteful + flaky). Above this → genuine
// two-sided. NB: it no longer gates SELLING — the close-sell + safety-sweep sell ANY non-SOL residual (gated by the
// SOL-value floor minSellOutLamports), so the copier wallet always returns to SOL-only. (Was DUST_TOKEN_RAW.)
export const BENCH_DUST_TOKEN_RAW = 1_000_000;

/**
 * Build the bench `CopybotConfig` PURELY (no I/O) from the defaults:
 *  - twoSidedMode 'on'                (was COPYBOT_TWO_SIDED='on')
 *  - infiniteAdd true                 (was COPYBOT_INFINITE_ADD='true' — the bench tests the RESIZE/GROW capability;
 *                                      the product default is false / first-deposit-only, but grow/lifecycle/two-sided
 *                                      tests need the leader's adds followed)
 *  - sizing.tradeRatioPct 50, sizing.minPositionSizeSol 0.02
 *  - execution.dustTokenRaw 1e6
 *  - the single test leader (LEADER_TEST)
 * `capsPatch` overlays the account-wide caps for the per-test config swaps the bench used to pass via extra env
 * (kill-switch, maxOpenPositions). Every other field falls through to the spec-locked `CONFIG_DEFAULTS`.
 */
export function buildBenchConfig(capsPatch: Partial<CapsConfig> = {}): CopybotConfig {
  const base = CONFIG_DEFAULTS.user;
  const user: UserSettings = {
    ...base,
    twoSidedMode: 'on',
    infiniteAdd: true,
    sizing: { ...base.sizing, tradeRatioPct: BENCH_TRADE_RATIO_PCT, minPositionSizeSol: BENCH_MIN_POSITION_SOL },
    execution: { ...base.execution, dustTokenRaw: BENCH_DUST_TOKEN_RAW },
    caps: { ...base.caps, ...capsPatch },
  };
  return { user, leaders: [{ address: LEADER_TEST.toBase58(), enabled: true, overrides: {} }] };
}

/**
 * Overwrite the DB `copybot.config` row with the bench config (validated by `ConfigStore.save`) BEFORE the brain
 * boots, so `seedIfAbsent()`/`load()` return it. `capsPatch` swaps caps for a specific test (default = base bench).
 */
export async function seedBenchConfig(db: Db, log: Logger, capsPatch: Partial<CapsConfig> = {}): Promise<CopybotConfig> {
  const cfg = buildBenchConfig(capsPatch);
  await new ConfigStore(db, log).save(cfg);
  return cfg;
}
