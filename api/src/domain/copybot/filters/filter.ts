/**
 * Copy-bot · entry-filter engine — shared contract (PURE, no I/O). Each filter is a self-describing
 * `FilterBrick` living in its own file; the registry (`./index`) runs them in order. Filters gate the OPEN
 * only — an ENABLED filter whose data is unknown ⇒ `skip` (a pre-open check: we cannot confirm the condition,
 * so we do not open). Spec: `docs/spec/19-entry-filter-engine.md` (+ `06` §1.4/§9).
 */
import type { BrickMeta, BrickScope, SpeedClass } from '../bricks';

export type FilterVerdict = { action: 'pass' } | { action: 'skip'; reason: string };
export const PASS: FilterVerdict = { action: 'pass' };
export const skip = (reason: string): FilterVerdict => ({ action: 'skip', reason });

/** The copy candidate under evaluation (the leader open we might mirror). */
export interface FilterCandidate {
  nonSolMint: string | null;
  pool: string;
}

/** Pre-fetched data the bricks read. `undefined` = not fetched ⇒ an enabled data-brick skips (no open). */
export interface FilterContext {
  tokenAgeHours?: number;
  marketCapUsd?: number;
  organicScore?: number;
  volume24hUsd?: number;
  holders?: number;
  priceRangePercent?: number;
  priceChangePercent?: number;
  /** non-SOL mints of positions we already hold OPEN (single-pool-per-token). */
  openTokenMints: Set<string>;
}

/** Where a brick's data comes from — the resolver groups bricks by source to fetch each source ONCE. */
export type DataSource = 'local' | 'leader-shape' | 'jupiter-token';

/** Filter settings; `null`/`false`/`[]` = OFF (default). One key per brick. */
export interface FilterConfig {
  ignoredTokens: string[];
  singlePoolPerToken: boolean;
  minPriceRangePercent: number | null;
  minTokenAgeHours: number | null;
  minMarketCapUsd: number | null;
  min24hVolumeUsd: number | null;
  maxPriceChangePercent: number | null;
  minJupOrganicScore: number | null;
  minHolders: number | null;
}

/** "All OFF" config — the default (every filter opt-in, `06` §1.4). */
export const FILTERS_ALL_OFF: FilterConfig = {
  ignoredTokens: [],
  singlePoolPerToken: false,
  minPriceRangePercent: null,
  minTokenAgeHours: null,
  minMarketCapUsd: null,
  min24hVolumeUsd: null,
  maxPriceChangePercent: null,
  minJupOrganicScore: null,
  minHolders: null,
};

/** A self-describing entry filter. Meta drives the settings UI + the source resolver; `evaluate` is pure. */
export interface FilterBrick extends BrickMeta {
  readonly family: 'filter';
  readonly source: DataSource;
  /** value applied WHEN the user enables this filter (`06` §1.4 "safe preset"); null = no numeric preset. */
  readonly safePreset: number | boolean | null;
  /** is this filter turned on in the resolved config? Pure. */
  enabled(cfg: FilterConfig): boolean;
  /** the pure decision over the candidate + pre-fetched context. Never does I/O, never throws. */
  evaluate(cfg: FilterConfig, candidate: FilterCandidate, ctx: FilterContext): FilterVerdict;
}

/** Skip if `value < min`; skip `${metric}_unavailable` if data is missing (enabled ⇒ unknown ⇒ no open). */
export function compareMin(value: number | undefined, min: number, metric: string): FilterVerdict {
  if (value === undefined) return skip(`${metric}_unavailable`);
  return value < min ? skip(`below_${metric}`) : PASS;
}

/** Skip if `value > max`; skip `${metric}_unavailable` if data is missing. */
export function compareMax(value: number | undefined, max: number, metric: string): FilterVerdict {
  if (value === undefined) return skip(`${metric}_unavailable`);
  return value > max ? skip(`above_${metric}`) : PASS;
}

/** Config keys carrying a numeric threshold (`number | null`). */
type NumericConfigKey = { [K in keyof FilterConfig]-?: FilterConfig[K] extends number | null ? K : never }[keyof FilterConfig];
/** Context keys carrying a numeric metric the bricks compare (`number | undefined`); `-?` so optional keys
 * don't leak `undefined` into the key union. */
type NumericContextKey = { [K in keyof FilterContext]-?: FilterContext[K] extends number | undefined ? K : never }[keyof FilterContext];

/** Declarative spec for a numeric-threshold filter (the shape shared by every min/max data brick). */
export interface NumericThresholdSpec {
  id: string;
  scope: BrickScope;
  speedClass: SpeedClass;
  source: DataSource;
  safePreset: number | null;
  /** the threshold setting (e.g. `minMarketCapUsd`). */
  configKey: NumericConfigKey;
  /** the metric it reads from the context (e.g. `marketCapUsd`). */
  contextKey: NumericContextKey;
  /** skip-reason stem (→ `below_*` / `above_*` / `*_unavailable`). */
  metric: string;
  /** `min` = skip below the threshold; `max` = skip above it. */
  bound: 'min' | 'max';
}

/** Build a numeric-threshold `FilterBrick` from a spec — one place for the enable/evaluate logic (no dup). */
export function numericThresholdBrick(spec: NumericThresholdSpec): FilterBrick {
  const compare = spec.bound === 'min' ? compareMin : compareMax;
  return {
    id: spec.id,
    family: 'filter',
    scope: spec.scope,
    speedClass: spec.speedClass,
    defaultEnabled: false,
    source: spec.source,
    safePreset: spec.safePreset,
    enabled: (cfg) => cfg[spec.configKey] != null,
    evaluate: (cfg, _candidate, ctx) => {
      const threshold = cfg[spec.configKey];
      return threshold == null ? PASS : compare(ctx[spec.contextKey], threshold, spec.metric);
    },
  };
}
