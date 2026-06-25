/**
 * Copy-bot · BRAIN — parse the per-process entry-filter config from env into a typed `FilterConfig`
 * (everything OFF unless explicitly set). `shadow` (default ON) evaluates + LOGS the verdict WITHOUT blocking
 * the open — flip it off to ENFORCE. Pure (env in → config out) so it is unit-tested without I/O.
 * Env keys: COPYBOT_FILTER_SHADOW, COPYBOT_FILTER_SINGLE_POOL_PER_TOKEN, COPYBOT_FILTER_IGNORED_TOKENS (csv),
 * COPYBOT_FILTER_{MIN_PRICE_RANGE_PCT,MIN_TOKEN_AGE_HOURS,MIN_MARKET_CAP_USD,MIN_24H_VOLUME_USD,
 * MAX_PRICE_CHANGE_PCT,MIN_ORGANIC_SCORE,MIN_HOLDERS}.
 */
import { type FilterConfig, FILTERS_ALL_OFF } from '@/domain/copybot/filters';

const TRUE = 'true';

/** Parse a numeric threshold env var; unset / blank / non-finite ⇒ null (filter stays OFF). */
function num(value: string | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface ParsedFilterConfig {
  config: FilterConfig;
  /** true = evaluate + log only (the open is NOT blocked); false = enforce the skip. */
  shadow: boolean;
}

export function parseFilterConfig(env: NodeJS.ProcessEnv): ParsedFilterConfig {
  const ignoredTokens = (env.COPYBOT_FILTER_IGNORED_TOKENS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    shadow: (env.COPYBOT_FILTER_SHADOW ?? TRUE) === TRUE,
    config: {
      ...FILTERS_ALL_OFF,
      ignoredTokens,
      singlePoolPerToken: env.COPYBOT_FILTER_SINGLE_POOL_PER_TOKEN === TRUE,
      minPriceRangePercent: num(env.COPYBOT_FILTER_MIN_PRICE_RANGE_PCT),
      minTokenAgeHours: num(env.COPYBOT_FILTER_MIN_TOKEN_AGE_HOURS),
      minMarketCapUsd: num(env.COPYBOT_FILTER_MIN_MARKET_CAP_USD),
      min24hVolumeUsd: num(env.COPYBOT_FILTER_MIN_24H_VOLUME_USD),
      maxPriceChangePercent: num(env.COPYBOT_FILTER_MAX_PRICE_CHANGE_PCT),
      minJupOrganicScore: num(env.COPYBOT_FILTER_MIN_ORGANIC_SCORE),
      minHolders: num(env.COPYBOT_FILTER_MIN_HOLDERS),
    },
  };
}
