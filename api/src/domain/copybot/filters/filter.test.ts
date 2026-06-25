import { describe, expect, it } from 'vitest';
import { compareMax, compareMin, FILTERS_ALL_OFF } from './filter';

describe('compareMin — inclusive lower bound; unknown ⇒ unavailable (enabled filter cannot open)', () => {
  it('missing data → skip <metric>_unavailable (we cannot confirm the condition → no open)', () => {
    expect(compareMin(undefined, 50, 'min_organic_score')).toEqual({ action: 'skip', reason: 'min_organic_score_unavailable' });
  });
  it('value < threshold → skip below_<metric>', () => {
    expect(compareMin(40, 50, 'min_organic_score')).toEqual({ action: 'skip', reason: 'below_min_organic_score' });
  });
  it('value ≥ threshold → pass (inclusive bound)', () => {
    expect(compareMin(50, 50, 'm')).toEqual({ action: 'pass' });
    expect(compareMin(60, 50, 'm')).toEqual({ action: 'pass' });
  });
});

describe('compareMax — inclusive upper bound', () => {
  it('missing data → skip <metric>_unavailable', () => {
    expect(compareMax(undefined, 20, 'max_price_change')).toEqual({ action: 'skip', reason: 'max_price_change_unavailable' });
  });
  it('value > threshold → skip above_<metric>', () => {
    expect(compareMax(30, 20, 'max_price_change')).toEqual({ action: 'skip', reason: 'above_max_price_change' });
  });
  it('value ≤ threshold → pass (inclusive bound)', () => {
    expect(compareMax(20, 20, 'm')).toEqual({ action: 'pass' });
  });
});

describe('FILTERS_ALL_OFF — every filter ships OFF (opt-in default)', () => {
  it('lists empty, toggles false, thresholds null', () => {
    expect(FILTERS_ALL_OFF.ignoredTokens).toEqual([]);
    expect(FILTERS_ALL_OFF.singlePoolPerToken).toBe(false);
    expect(FILTERS_ALL_OFF.minPriceRangePercent).toBeNull();
    expect(FILTERS_ALL_OFF.minTokenAgeHours).toBeNull();
    expect(FILTERS_ALL_OFF.minMarketCapUsd).toBeNull();
    expect(FILTERS_ALL_OFF.min24hVolumeUsd).toBeNull();
    expect(FILTERS_ALL_OFF.maxPriceChangePercent).toBeNull();
    expect(FILTERS_ALL_OFF.minJupOrganicScore).toBeNull();
    expect(FILTERS_ALL_OFF.minHolders).toBeNull();
  });
});
