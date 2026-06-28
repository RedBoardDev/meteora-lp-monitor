/**
 * Copy-bot · runtime config — TYPES (two-tier: USER defaults + per-LEADER overrides).
 *
 * One JSON blob persisted in `settings` → `copybot.config`, hot-reloaded by both processes. The web/CLI edits it;
 * the bot reads `effectiveFor(leader)` per event. Infra/secrets stay in the environment (NOT here).
 *
 * Single-user for now: ONE `user` block + a `leaders[]` list. Multi-user (Privy) later = a `userId` wrap around
 * this same shape — do not model `users[]` yet (YAGNI).
 */
import type { CapsConfig } from '../caps';
import type { FilterConfig } from '../filters';
import type { PriorityFeeConfig } from '../priority-fee';
import type { RugSlConfig } from '../rug-sl';
import type { SizingConfig } from '../sizing';

export const TWO_SIDED_MODES = ['off', 'shadow', 'on'] as const;
export type TwoSidedMode = (typeof TWO_SIDED_MODES)[number];

/** Swap + reshape execution tunables. Raw-unit fields are JS numbers in the JSON config, widened to BigInt at use. */
export interface ExecutionConfig {
  /** Swap slippage tolerance (residual sell + two-sided buy), basis points. */
  slippageBps: number;
  /** Residual token units at/below which we don't bother selling (dust). */
  dustTokenRaw: number;
  /** Skip a residual sell whose SOL-out floor is below this (lamports) — not worth the fees. */
  minSellOutLamports: number;
  /** Per-bin reshape threshold (SOL): act on a bin whose SOL differs from target by more than this. */
  reshapeBinDeadbandSol: number;
  /** Per-bin reshape threshold (raw token units) for the two-sided token leg. */
  reshapeBinDeadbandToken: number;
}

/** The fields a leader may override on top of the user defaults. */
export interface Overridable {
  sizing: SizingConfig;
  twoSidedMode: TwoSidedMode;
  /** Entry-filter thresholds/toggles (the filter brick registry consumes this). */
  filters: FilterConfig;
  /** Swap/reshape execution tunables. */
  execution: ExecutionConfig;
  /** Priority-fee tier + hard SOL cap (see priority-fee.ts). */
  priorityFee: PriorityFeeConfig;
  /** Rug-SL safety exit (crash protection; see rug-sl.ts). */
  rugSl: RugSlConfig;
  /** Copy EVERY leader add-liquidity (grow with the leader), or only the first deposit. Removes are always followed. */
  infiniteAdd: boolean;
  /** Mirror a leader fee-claim only if it claimed ≥ this many SOL (skip dust claims; 0 = mirror all). */
  claimFloorSol: number;
}

/** Account-global settings (defaults for every leader). */
export interface UserSettings extends Overridable {
  /** Master switch. `false` ⇒ no new opens (exits + reconciliation keep running). */
  enabled: boolean;
  /** Account-wide caps (across all leaders). */
  caps: CapsConfig;
  /** Land txs as Jito bundles (anti-sandwich) when a block-engine URL is configured. Account-wide (not per-leader). */
  jitoEnabled: boolean;
  /** Back the priority-fee tier with a live network estimate (raises the fee in congestion; cap still bounds it). Account-wide. */
  priorityFeeOracle: boolean;
}

/** A sparse per-leader override: only the fields this leader changes from the user defaults. */
export type LeaderOverride = {
  sizing?: Partial<SizingConfig>;
  twoSidedMode?: TwoSidedMode;
  filters?: Partial<FilterConfig>;
  execution?: Partial<ExecutionConfig>;
  priorityFee?: Partial<PriorityFeeConfig>;
  rugSl?: Partial<RugSlConfig>;
  infiniteAdd?: boolean;
  claimFloorSol?: number;
};

/** One followed leader. */
export interface LeaderSettings {
  address: string;
  /** Per-leader pause switch (others unaffected). Bridges the resolved `caps.killSwitchLeader`. */
  enabled: boolean;
  overrides: LeaderOverride;
}

/** The full persisted blob. */
export interface CopybotConfig {
  user: UserSettings;
  leaders: LeaderSettings[];
}

/** The resolved config a handler consumes for ONE leader = merge(user defaults, leader overrides). */
export interface EffectiveConfig extends Overridable {
  /** Resolved caps for this leader (`killSwitchLeader` derived from the leader's `enabled`). */
  caps: CapsConfig;
  /** The account master switch (copied through for the handler's convenience). */
  userEnabled: boolean;
  /** This leader's own switch. */
  leaderEnabled: boolean;
}

/** A last-layer override (env / bench) applied AFTER `effectiveFor`. Migration bridge — removed once the bench
 *  drives the config directly. */
export type EffectiveOverride = {
  sizing?: Partial<SizingConfig>;
  caps?: Partial<CapsConfig>;
  twoSidedMode?: TwoSidedMode;
  filters?: Partial<FilterConfig>;
  execution?: Partial<ExecutionConfig>;
  priorityFee?: Partial<PriorityFeeConfig>;
  rugSl?: Partial<RugSlConfig>;
  infiniteAdd?: boolean;
  claimFloorSol?: number;
  userEnabled?: boolean;
};
