/**
 * Copy-bot · BRAIN — env → `EffectiveOverride` (MIGRATION BRIDGE, temporary).
 *
 * The DB config is authoritative; this layer lets the on-chain bench keep driving the bot via env without breaking
 * "DB-authoritative": every field is SPARSE — included ONLY when its env var is set, so an unset var falls through
 * to the DB value. Delete this whole module once the bench writes the config directly.
 *
 * Env keys: COPYBOT_{KILL_SWITCH,KILL_SWITCH_LEADER,MAX_OPEN_POSITIONS,MIN_POSITION_SOL,TWO_SIDED} +
 * COPYBOT_FILTER_{SHADOW,SINGLE_POOL_PER_TOKEN,IGNORED_TOKENS,MIN_PRICE_RANGE_PCT,MIN_TOKEN_AGE_HOURS,
 * MIN_MARKET_CAP_USD,MIN_24H_VOLUME_USD,MAX_PRICE_CHANGE_PCT,MIN_ORGANIC_SCORE,MIN_HOLDERS}.
 */
import type { EffectiveOverride, TwoSidedMode } from '@/domain/copybot/config';
import type { FilterConfig } from '@/domain/copybot/filters';

const TRUE = 'true';

/** Parse a numeric env var; blank/non-finite ⇒ null (i.e. the filter is explicitly turned off). */
function num(value: string | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Build the SPARSE filter override: only the filters whose env var is present (else the DB value stands). */
function envFilters(env: NodeJS.ProcessEnv): { filters?: Partial<FilterConfig>; filterShadow?: boolean } {
  const f: Partial<FilterConfig> = {};
  if (env.COPYBOT_FILTER_IGNORED_TOKENS !== undefined) {
    f.ignoredTokens = env.COPYBOT_FILTER_IGNORED_TOKENS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (env.COPYBOT_FILTER_SINGLE_POOL_PER_TOKEN !== undefined) f.singlePoolPerToken = env.COPYBOT_FILTER_SINGLE_POOL_PER_TOKEN === TRUE;
  const numKeys: Array<[keyof FilterConfig, string | undefined]> = [
    ['minPriceRangePercent', env.COPYBOT_FILTER_MIN_PRICE_RANGE_PCT],
    ['minTokenAgeHours', env.COPYBOT_FILTER_MIN_TOKEN_AGE_HOURS],
    ['minMarketCapUsd', env.COPYBOT_FILTER_MIN_MARKET_CAP_USD],
    ['min24hVolumeUsd', env.COPYBOT_FILTER_MIN_24H_VOLUME_USD],
    ['maxPriceChangePercent', env.COPYBOT_FILTER_MAX_PRICE_CHANGE_PCT],
    ['minJupOrganicScore', env.COPYBOT_FILTER_MIN_ORGANIC_SCORE],
    ['minHolders', env.COPYBOT_FILTER_MIN_HOLDERS],
  ];
  for (const [key, raw] of numKeys) if (raw !== undefined) (f as Record<string, number | null>)[key] = num(raw);

  const out: { filters?: Partial<FilterConfig>; filterShadow?: boolean } = {};
  if (Object.keys(f).length > 0) out.filters = f;
  if (env.COPYBOT_FILTER_SHADOW !== undefined) out.filterShadow = env.COPYBOT_FILTER_SHADOW === TRUE;
  return out;
}

/** The full sparse env override applied after `effectiveFor` (see `withEnvOverride`). */
export function envEffectiveOverride(env: NodeJS.ProcessEnv): EffectiveOverride {
  const toNum = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
  const toBool = (v: string | undefined): boolean | undefined => (v === undefined ? undefined : v === TRUE);

  const sizing: NonNullable<EffectiveOverride['sizing']> = {};
  const minPos = toNum(env.COPYBOT_MIN_POSITION_SOL);
  if (minPos !== undefined) sizing.minPositionSizeSol = minPos;

  const caps: NonNullable<EffectiveOverride['caps']> = {};
  const ksg = toBool(env.COPYBOT_KILL_SWITCH);
  if (ksg !== undefined) caps.killSwitchGlobal = ksg;
  const ksl = toBool(env.COPYBOT_KILL_SWITCH_LEADER);
  if (ksl !== undefined) caps.killSwitchLeader = ksl;
  const maxOpen = toNum(env.COPYBOT_MAX_OPEN_POSITIONS);
  if (maxOpen !== undefined) caps.maxOpenPositions = maxOpen;

  return {
    sizing,
    caps,
    twoSidedMode: env.COPYBOT_TWO_SIDED as TwoSidedMode | undefined,
    ...envFilters(env),
  };
}
