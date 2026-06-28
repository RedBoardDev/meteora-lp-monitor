/**
 * Copy-bot · runtime config — `effectiveFor(leader)`: the resolved config a handler consumes.
 *
 * `effective = merge(user defaults, leader overrides)`. Pure, per-event (no cache). The per-leader `enabled` switch
 * and the user master switch are folded into the resolved `caps` (`killSwitchLeader` / `killSwitchGlobal`) so the
 * existing `checkCaps` enforces them unchanged. A leader may only TIGHTEN the size cap, never raise it.
 */
import type { CapsConfig } from '../caps';
import type { FilterConfig } from '../filters';
import type { PriorityFeeConfig } from '../priority-fee';
import type { RugSlConfig } from '../rug-sl';
import type { SizingConfig } from '../sizing';
import type { CopybotConfig, EffectiveConfig, EffectiveOverride, ExecutionConfig } from './types';

/** Merge a sparse leader sizing override onto the user sizing. `maxTradeSizeSol` is lower-only (tighten, never raise). */
function mergeSizing(base: SizingConfig, ov?: Partial<SizingConfig>): SizingConfig {
  if (!ov) return base;
  const merged: SizingConfig = { ...base, ...ov };
  if (ov.maxTradeSizeSol !== undefined) merged.maxTradeSizeSol = Math.min(base.maxTradeSizeSol, ov.maxTradeSizeSol);
  return merged;
}

/** Merge a sparse filter override (per-leader, or env bridge) onto a base filter config. */
function mergeFilters(base: FilterConfig, ov?: Partial<FilterConfig>): FilterConfig {
  return ov ? { ...base, ...ov } : base;
}

/** Merge a sparse execution override (per-leader, or env bridge) onto a base execution config. */
function mergeExecution(base: ExecutionConfig, ov?: Partial<ExecutionConfig>): ExecutionConfig {
  return ov ? { ...base, ...ov } : base;
}

/** Merge a sparse priority-fee override (per-leader, or env bridge) onto a base priority-fee config. */
function mergePriorityFee(base: PriorityFeeConfig, ov?: Partial<PriorityFeeConfig>): PriorityFeeConfig {
  return ov ? { ...base, ...ov } : base;
}

/** Merge a sparse rug-SL override (per-leader, or env bridge) onto a base rug-SL config. */
function mergeRugSl(base: RugSlConfig, ov?: Partial<RugSlConfig>): RugSlConfig {
  return ov ? { ...base, ...ov } : base;
}

/** Resolve the config for ONE leader. Unknown address ⇒ user defaults with the leader treated as enabled. */
export function effectiveFor(cfg: CopybotConfig, address: string): EffectiveConfig {
  const user = cfg.user;
  const leader = cfg.leaders.find((l) => l.address === address);
  const ov = leader?.overrides ?? {};
  const leaderEnabled = leader?.enabled ?? true;
  const caps: CapsConfig = {
    ...user.caps,
    killSwitchGlobal: user.caps.killSwitchGlobal || !user.enabled, // master switch off ⇒ no opens
    killSwitchLeader: user.caps.killSwitchLeader || !leaderEnabled, // per-leader pause
  };
  return {
    sizing: mergeSizing(user.sizing, ov.sizing),
    twoSidedMode: ov.twoSidedMode ?? user.twoSidedMode,
    filters: mergeFilters(user.filters, ov.filters),
    execution: mergeExecution(user.execution, ov.execution),
    priorityFee: mergePriorityFee(user.priorityFee, ov.priorityFee),
    rugSl: mergeRugSl(user.rugSl, ov.rugSl),
    infiniteAdd: ov.infiniteAdd ?? user.infiniteAdd,
    caps,
    userEnabled: user.enabled,
    leaderEnabled,
  };
}

/**
 * Apply a last-layer override (env / bench) AFTER `effectiveFor`. Migration bridge ONLY — the bench drives the bot
 * via env today; removed once it drives the config directly. An undefined field leaves the resolved value intact.
 */
export function withEnvOverride(eff: EffectiveConfig, ov: EffectiveOverride): EffectiveConfig {
  return {
    ...eff,
    sizing: ov.sizing ? { ...eff.sizing, ...ov.sizing } : eff.sizing,
    caps: ov.caps ? { ...eff.caps, ...ov.caps } : eff.caps,
    twoSidedMode: ov.twoSidedMode ?? eff.twoSidedMode,
    filters: mergeFilters(eff.filters, ov.filters),
    execution: mergeExecution(eff.execution, ov.execution),
    priorityFee: mergePriorityFee(eff.priorityFee, ov.priorityFee),
    rugSl: mergeRugSl(eff.rugSl, ov.rugSl),
    infiniteAdd: ov.infiniteAdd ?? eff.infiniteAdd,
    userEnabled: ov.userEnabled ?? eff.userEnabled,
  };
}
