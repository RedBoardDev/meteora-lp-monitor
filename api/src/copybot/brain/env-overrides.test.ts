import { describe, expect, it } from 'vitest';
import { envEffectiveOverride } from './env-overrides';

describe('envEffectiveOverride — SPARSE env bridge (DB stays authoritative)', () => {
  it('empty env → no overriding fields (sizing/caps empty, twoSided/filters/shadow absent)', () => {
    // WHY: with no env set, the DB config must win entirely — the bridge must add NOTHING.
    const ov = envEffectiveOverride({});
    expect(ov.sizing).toEqual({});
    expect(ov.caps).toEqual({});
    expect(ov.twoSidedMode).toBeUndefined();
    expect(ov.filters).toBeUndefined();
    expect(ov.filterShadow).toBeUndefined();
  });

  it('only the SET env vars appear in the override (sizing/caps/twoSided)', () => {
    const ov = envEffectiveOverride({ COPYBOT_KILL_SWITCH: 'true', COPYBOT_MAX_OPEN_POSITIONS: '3', COPYBOT_TWO_SIDED: 'on' });
    expect(ov.caps).toEqual({ killSwitchGlobal: true, maxOpenPositions: 3 });
    expect(ov.twoSidedMode).toBe('on');
    expect(ov.sizing).toEqual({}); // COPYBOT_MIN_POSITION_SOL unset → not present
  });

  it('filters are sparse: only env-set filters appear, the rest fall through to the DB', () => {
    const ov = envEffectiveOverride({ COPYBOT_FILTER_MIN_ORGANIC_SCORE: '50', COPYBOT_FILTER_SINGLE_POOL_PER_TOKEN: 'true' });
    expect(ov.filters).toEqual({ minJupOrganicScore: 50, singlePoolPerToken: true });
    expect(ov.filterShadow).toBeUndefined(); // unset → DB shadow flag stands
  });

  it('a blank filter env var explicitly turns that filter OFF (null), distinct from unset', () => {
    // WHY: presence of the var = override intent; blank = "off". Unset = "leave the DB value".
    const ov = envEffectiveOverride({ COPYBOT_FILTER_MIN_ORGANIC_SCORE: '' });
    expect(ov.filters).toEqual({ minJupOrganicScore: null });
  });

  it('COPYBOT_FILTER_SHADOW maps to the shadow flag only when set', () => {
    expect(envEffectiveOverride({ COPYBOT_FILTER_SHADOW: 'false' }).filterShadow).toBe(false);
    expect(envEffectiveOverride({ COPYBOT_FILTER_SHADOW: 'true' }).filterShadow).toBe(true);
  });

  it('ignored-tokens csv is trimmed and blanks dropped', () => {
    expect(envEffectiveOverride({ COPYBOT_FILTER_IGNORED_TOKENS: ' A , ,B ' }).filters).toEqual({ ignoredTokens: ['A', 'B'] });
  });
});
