/**
 * Copy-bot · runtime config — DEFAULTS.
 *
 * Increment 1a is a PURE structural move: these reproduce TODAY's values exactly (no behavior change). The
 * spec-locked policy values (e.g. ratio 100%) are applied in a separate, bench-verified step.
 */
import { CAPS_DEFAULTS } from '../caps';
import { FILTERS_ALL_OFF } from '../filters';
import type { CopybotConfig, UserSettings } from './types';

/** The single followed leader (was the `COPYBOT_LEADER` env default). */
export const DEFAULT_LEADER_ADDRESS = '8ryctvNwpJTuuap3wuNTfcyEx4DjSuXvhGXSDHNaU8sQ';

export const USER_DEFAULTS: UserSettings = {
  enabled: true,
  sizing: { tradeRatioPct: 50, maxTradeSizeSol: 1.0, minPositionSizeSol: 0.05, solReserveSol: 0.05, onInsufficient: 'skip' },
  caps: { ...CAPS_DEFAULTS },
  twoSidedMode: 'off',
  filters: { ...FILTERS_ALL_OFF }, // all entry filters OFF by default
  filterShadow: true, // safe rollout: evaluate + log, never block (flip off to enforce)
  execution: {
    slippageBps: 100, // 1% — permissive enough to land
    dustTokenRaw: 0, // sell any residual by default
    minSellOutLamports: 50_000, // ~0.00005 SOL floor: below it a residual sell isn't worth the fees
    reshapeBinDeadbandSol: 0.0002, // LOW: reshapes are event-driven (not arb), so a low threshold maximizes fidelity
    reshapeBinDeadbandToken: 100, // LOW per-bin token-leg threshold (two-sided reshape), same rationale as the SOL one
  },
};

export const CONFIG_DEFAULTS: CopybotConfig = {
  user: USER_DEFAULTS,
  leaders: [{ address: DEFAULT_LEADER_ADDRESS, enabled: true, overrides: {} }],
};
