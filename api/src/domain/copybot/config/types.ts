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
import type { SizingConfig } from '../sizing';

export const TWO_SIDED_MODES = ['off', 'shadow', 'on'] as const;
export type TwoSidedMode = (typeof TWO_SIDED_MODES)[number];

/** The fields a leader may override on top of the user defaults. */
export interface Overridable {
  sizing: SizingConfig;
  twoSidedMode: TwoSidedMode;
}

/** Account-global settings (defaults for every leader). */
export interface UserSettings extends Overridable {
  /** Master switch. `false` ⇒ no new opens (exits + reconciliation keep running). */
  enabled: boolean;
  /** Account-wide caps (across all leaders). */
  caps: CapsConfig;
}

/** A sparse per-leader override: only the fields this leader changes from the user defaults. */
export type LeaderOverride = {
  sizing?: Partial<SizingConfig>;
  twoSidedMode?: TwoSidedMode;
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
  userEnabled?: boolean;
};
