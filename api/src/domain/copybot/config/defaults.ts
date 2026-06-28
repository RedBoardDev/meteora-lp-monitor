/**
 * Copy-bot · runtime config — DEFAULTS (the spec-locked values; see docs/reference/copybot-settings.md).
 * Defaults only seed a FRESH config + the parse fallback — an existing stored config is preserved.
 */
import { CAPS_DEFAULTS } from '../caps';
import { FILTERS_ALL_OFF } from '../filters';
import type { CopybotConfig, UserSettings } from './types';

/** The single followed leader (was the `COPYBOT_LEADER` env default). */
export const DEFAULT_LEADER_ADDRESS = '8ryctvNwpJTuuap3wuNTfcyEx4DjSuXvhGXSDHNaU8sQ';

export const USER_DEFAULTS: UserSettings = {
  enabled: true,
  sizing: { tradeRatioPct: 100, maxTradeSizeSol: 1.0, minPositionSizeSol: 0.05, solReserveSol: 0.05, onInsufficient: 'skip' }, // 100% = follow the leader, capped by maxTradeSize (spec §3)
  caps: { ...CAPS_DEFAULTS },
  twoSidedMode: 'off',
  filters: { ...FILTERS_ALL_OFF }, // all entry filters OFF by default; an enabled filter ENFORCES (no shadow mode)
  execution: {
    slippageBps: 100, // 1% — permissive enough to land
    dustTokenRaw: 0, // sell any residual by default
    minSellOutLamports: 50_000, // ~0.00005 SOL floor: below it a residual sell isn't worth the fees
    reshapeBinDeadbandSol: 0.0002, // LOW: reshapes are event-driven (not arb), so a low threshold maximizes fidelity
    reshapeBinDeadbandToken: 100, // LOW per-bin token-leg threshold (two-sided reshape), same rationale as the SOL one
  },
  priorityFee: { tier: 'medium', maxCapSol: 0.005 }, // capped CU price on every tx (spec §5)
  rugSl: { enabled: true, dropPercent: 40, windowSeconds: 60 }, // crash safety exit on by default (spec §7)
};

export const CONFIG_DEFAULTS: CopybotConfig = {
  user: USER_DEFAULTS,
  leaders: [{ address: DEFAULT_LEADER_ADDRESS, enabled: true, overrides: {} }],
};
