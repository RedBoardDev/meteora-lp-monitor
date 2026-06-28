import { describe, expect, it } from 'vitest';
import { type FilterConfig, type FilterContext, FILTERS_ALL_OFF } from './filter';
import { FILTER_BRICKS, filtersActive, neededSources, REGISTRY, runFilters } from './index';

const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({ openTokenMints: new Set(), ...over });
const candidate = { nonSolMint: 'MINT', pool: 'POOL' };

describe('runFilters — registry orchestration (first skip wins, instant-first order)', () => {
  it('all OFF → pass', () => {
    expect(runFilters(candidate, ctx(), FILTERS_ALL_OFF)).toEqual({ action: 'pass' });
  });

  it('ignoredTokens matched → skip ignored_token', () => {
    expect(runFilters(candidate, ctx(), { ...FILTERS_ALL_OFF, ignoredTokens: ['MINT'] })).toEqual({ action: 'skip', reason: 'ignored_token' });
  });

  it('singlePoolPerToken, token already held → skip single_pool_per_token', () => {
    const cfg = { ...FILTERS_ALL_OFF, singlePoolPerToken: true };
    expect(runFilters(candidate, ctx({ openTokenMints: new Set(['MINT']) }), cfg)).toEqual({ action: 'skip', reason: 'single_pool_per_token' });
  });

  it('data filter below threshold → skip below_', () => {
    const cfg = { ...FILTERS_ALL_OFF, minMarketCapUsd: 1_000_000 };
    expect(runFilters(candidate, ctx({ marketCapUsd: 500_000 }), cfg)).toEqual({ action: 'skip', reason: 'below_min_market_cap' });
  });

  it('data filter enabled but data missing → skip _unavailable (no open on unverifiable data)', () => {
    const cfg = { ...FILTERS_ALL_OFF, minJupOrganicScore: 50 };
    expect(runFilters(candidate, ctx(), cfg)).toEqual({ action: 'skip', reason: 'min_organic_score_unavailable' });
  });

  it('first skip wins: ignoredTokens runs BEFORE singlePool (instant order preserved)', () => {
    const cfg = { ...FILTERS_ALL_OFF, ignoredTokens: ['MINT'], singlePoolPerToken: true };
    expect(runFilters(candidate, ctx({ openTokenMints: new Set(['MINT']) }), cfg)).toEqual({ action: 'skip', reason: 'ignored_token' });
  });

  it('ALL filters enabled and satisfied → pass (exercises every activation branch)', () => {
    const cfg: FilterConfig = {
      ignoredTokens: ['OTHER'],
      singlePoolPerToken: true,
      minPriceRangePercent: 3,
      minTokenAgeHours: 2,
      minMarketCapUsd: 1_000_000,
      min24hVolumeUsd: 1000,
      maxPriceChangePercent: 40,
      minJupOrganicScore: 50,
      minHolders: 100,
    };
    const fullCtx = ctx({
      openTokenMints: new Set(['OTHER_TOKEN']),
      tokenAgeHours: 10,
      marketCapUsd: 5_000_000,
      organicScore: 80,
      volume24hUsd: 50_000,
      holders: 500,
      priceRangePercent: 6,
      priceChangePercent: 5,
    });
    expect(runFilters(candidate, fullCtx, cfg)).toEqual({ action: 'pass' });
  });
});

describe('FILTER_BRICKS catalogue', () => {
  it('all ship OFF by default + family is filter', () => {
    expect(FILTER_BRICKS.every((b) => b.defaultEnabled === false)).toBe(true);
    expect(FILTER_BRICKS.every((b) => b.family === 'filter')).toBe(true);
  });

  it('safe presets match the spec (age 2h, mcap $1M, organic 50, range 3%, singlePool ON)', () => {
    const byId = Object.fromEntries(FILTER_BRICKS.map((b) => [b.id, b]));
    expect(byId.minTokenAgeHours?.safePreset).toBe(2);
    expect(byId.minMarketCapUsd?.safePreset).toBe(1_000_000);
    expect(byId.minJupOrganicScore?.safePreset).toBe(50);
    expect(byId.minPriceRangePercent?.safePreset).toBe(3);
    expect(byId.singlePoolPerToken?.safePreset).toBe(true);
    expect(byId.ignoredTokens?.scope).toBe('user-global'); // ignoredTokens = global-only
  });

  it('unique ids', () => {
    const ids = FILTER_BRICKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('registry is instant-first (no instant brick appears after a non-instant one)', () => {
    const order = REGISTRY.map((b) => b.speedClass);
    const lastInstant = order.lastIndexOf('instant');
    const firstNonInstant = order.findIndex((s) => s !== 'instant');
    expect(firstNonInstant === -1 || firstNonInstant > lastInstant).toBe(true);
  });
});

describe('neededSources — only ENABLED bricks contribute, one shared source (not per-metric)', () => {
  it('all OFF → no external source', () => {
    expect(neededSources(FILTERS_ALL_OFF).size).toBe(0);
  });

  it('only local/leader-shape filters on → still no external source', () => {
    const cfg = { ...FILTERS_ALL_OFF, ignoredTokens: ['X'], singlePoolPerToken: true, minPriceRangePercent: 3 };
    expect(neededSources(cfg).size).toBe(0);
  });

  it('several Jupiter-backed filters on → exactly { jupiter-token } (ONE shared call, not N)', () => {
    const cfg = { ...FILTERS_ALL_OFF, minMarketCapUsd: 1_000_000, minJupOrganicScore: 50, minHolders: 100 };
    expect([...neededSources(cfg)]).toEqual(['jupiter-token']);
  });
});

describe('filtersActive — drives the per-open observability log', () => {
  it('all OFF → false (no filter gating the open)', () => {
    expect(filtersActive(FILTERS_ALL_OFF)).toBe(false);
  });

  it('any single brick on → true (free local filter counts too)', () => {
    expect(filtersActive({ ...FILTERS_ALL_OFF, singlePoolPerToken: true })).toBe(true);
    expect(filtersActive({ ...FILTERS_ALL_OFF, minHolders: 100 })).toBe(true);
  });
});
