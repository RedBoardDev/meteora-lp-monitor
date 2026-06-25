import { describe, expect, it } from 'vitest';
import { FILTERS_ALL_OFF } from '@/domain/copybot/filters';
import { parseFilterConfig } from './filter-config';

describe('parseFilterConfig — typed env → FilterConfig (all OFF unless set), shadow default ON', () => {
  it('empty env → ALL_OFF + shadow ON (safe default: observe, never block)', () => {
    const { config, shadow } = parseFilterConfig({});
    expect(config).toEqual(FILTERS_ALL_OFF);
    expect(shadow).toBe(true);
  });

  it('parses thresholds; blank/non-numeric → null (filter stays OFF)', () => {
    const { config } = parseFilterConfig({
      COPYBOT_FILTER_MIN_ORGANIC_SCORE: '50',
      COPYBOT_FILTER_MIN_MARKET_CAP_USD: '1000000',
      COPYBOT_FILTER_MIN_TOKEN_AGE_HOURS: '',
      COPYBOT_FILTER_MIN_HOLDERS: 'abc',
    });
    expect(config.minJupOrganicScore).toBe(50);
    expect(config.minMarketCapUsd).toBe(1_000_000);
    expect(config.minTokenAgeHours).toBeNull();
    expect(config.minHolders).toBeNull();
  });

  it('toggles + ignored-tokens csv (trimmed, blanks dropped)', () => {
    const { config } = parseFilterConfig({
      COPYBOT_FILTER_SINGLE_POOL_PER_TOKEN: 'true',
      COPYBOT_FILTER_IGNORED_TOKENS: ' A , ,B ',
    });
    expect(config.singlePoolPerToken).toBe(true);
    expect(config.ignoredTokens).toEqual(['A', 'B']);
  });

  it('COPYBOT_FILTER_SHADOW=false → enforce mode', () => {
    expect(parseFilterConfig({ COPYBOT_FILTER_SHADOW: 'false' }).shadow).toBe(false);
  });
});
