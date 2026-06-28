/**
 * Copy-bot · entry-filter REGISTRY. The ordered brick array IS the run order (instant-first, so cheap local
 * rejects short-circuit before any external data) AND the settings catalogue. Adding a filter = one folder +
 * one line here — the config interface is generated from this registry, never hand-maintained (`06` §9).
 * Spec: `docs/spec/19-entry-filter-engine.md`.
 */
import {
  type DataSource,
  type FilterBrick,
  type FilterCandidate,
  type FilterConfig,
  type FilterContext,
  type FilterVerdict,
  PASS,
} from './filter';
import { ignoredTokens } from './ignored-tokens/ignored-tokens';
import { maxPriceChangePercent } from './max-price-change/max-price-change';
import { min24hVolumeUsd } from './min-24h-volume/min-24h-volume';
import { minHolders } from './min-holders/min-holders';
import { minJupOrganicScore } from './min-jup-organic-score/min-jup-organic-score';
import { minMarketCapUsd } from './min-market-cap/min-market-cap';
import { minPriceRangePercent } from './min-price-range/min-price-range';
import { minTokenAgeHours } from './min-token-age/min-token-age';
import { singlePoolPerToken } from './single-pool-per-token/single-pool-per-token';

export * from './filter';
export * from './sources/source';
export { snapshotToContext } from './sources/snapshot';
export { type ResolveDeps, resolveFilterContext } from './sources/resolve';
export { rangeCoveragePercent } from './sources/leader-shape';

/** Run order: instant/local first (free, short-circuiting), then cached/external Jupiter-backed filters. */
export const REGISTRY: readonly FilterBrick[] = [
  ignoredTokens,
  singlePoolPerToken,
  minPriceRangePercent,
  minTokenAgeHours,
  minMarketCapUsd,
  min24hVolumeUsd,
  maxPriceChangePercent,
  minJupOrganicScore,
  minHolders,
];

/** Catalogue alias for the settings UI / tests (the registry IS the catalogue). */
export const FILTER_BRICKS = REGISTRY;

const FREE_SOURCES: ReadonlySet<DataSource> = new Set<DataSource>(['local', 'leader-shape']);

/** Run the ENABLED filters in registry order; the first skip wins, else pass. Pure. */
export function runFilters(candidate: FilterCandidate, ctx: FilterContext, cfg: FilterConfig): FilterVerdict {
  for (const brick of REGISTRY) {
    if (!brick.enabled(cfg)) continue;
    const v = brick.evaluate(cfg, candidate, ctx);
    if (v.action === 'skip') return v;
  }
  return PASS;
}

/** External data sources to fetch for the ENABLED filters (local/leader-shape are free). Pure. */
export function neededSources(cfg: FilterConfig): Set<DataSource> {
  const out = new Set<DataSource>();
  for (const brick of REGISTRY) {
    if (brick.enabled(cfg) && !FREE_SOURCES.has(brick.source)) out.add(brick.source);
  }
  return out;
}


/** Whether ANY entry filter is turned on in this config — drives the per-open observability log. Pure. */
export function filtersActive(cfg: FilterConfig): boolean {
  return REGISTRY.some((brick) => brick.enabled(cfg));
}
