/**
 * Copy-bot · runtime config — DEFAULTS.
 *
 * Increment 1a is a PURE structural move: these reproduce TODAY's values exactly (no behavior change). The
 * spec-locked policy values (e.g. ratio 100%) are applied in a separate, bench-verified step.
 */
import { CAPS_DEFAULTS } from '../caps';
import type { CopybotConfig, UserSettings } from './types';

/** The single followed leader (was the `COPYBOT_LEADER` env default). */
export const DEFAULT_LEADER_ADDRESS = '8ryctvNwpJTuuap3wuNTfcyEx4DjSuXvhGXSDHNaU8sQ';

export const USER_DEFAULTS: UserSettings = {
  enabled: true,
  sizing: { tradeRatioPct: 50, maxTradeSizeSol: 1.0, minPositionSizeSol: 0.05, solReserveSol: 0.05, onInsufficient: 'skip' },
  caps: { ...CAPS_DEFAULTS },
  twoSidedMode: 'off',
};

export const CONFIG_DEFAULTS: CopybotConfig = {
  user: USER_DEFAULTS,
  leaders: [{ address: DEFAULT_LEADER_ADDRESS, enabled: true, overrides: {} }],
};
