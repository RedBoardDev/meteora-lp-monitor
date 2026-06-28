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
  });

  it('only the SET env vars appear in the override (sizing/caps/twoSided)', () => {
    const ov = envEffectiveOverride({ COPYBOT_KILL_SWITCH: 'true', COPYBOT_MAX_OPEN_POSITIONS: '3', COPYBOT_TWO_SIDED: 'on' });
    expect(ov.caps).toEqual({ killSwitchGlobal: true, maxOpenPositions: 3 });
    expect(ov.twoSidedMode).toBe('on');
    expect(ov.sizing).toEqual({}); // COPYBOT_MIN_POSITION_SOL / COPYBOT_TRADE_RATIO_PCT unset → not present
  });

  it('COPYBOT_TRADE_RATIO_PCT overrides the copy ratio (the bench drives 1:1 vs half); a non-finite value is dropped', () => {
    // WHY: the two-tier config moved the ratio to the DB (default 100); the bench needs an env lever to run at 0.5.
    expect(envEffectiveOverride({ COPYBOT_TRADE_RATIO_PCT: '50' }).sizing).toEqual({ tradeRatioPct: 50 });
    expect(envEffectiveOverride({ COPYBOT_TRADE_RATIO_PCT: 'oops' }).sizing).toEqual({}); // NaN dropped, DB ratio stands
  });

  it('filters are sparse: only env-set filters appear, the rest fall through to the DB', () => {
    const ov = envEffectiveOverride({ COPYBOT_FILTER_MIN_ORGANIC_SCORE: '50', COPYBOT_FILTER_SINGLE_POOL_PER_TOKEN: 'true' });
    expect(ov.filters).toEqual({ minJupOrganicScore: 50, singlePoolPerToken: true });
  });

  it('a blank filter env var explicitly turns that filter OFF (null), distinct from unset', () => {
    // WHY: presence of the var = override intent; blank = "off". Unset = "leave the DB value".
    const ov = envEffectiveOverride({ COPYBOT_FILTER_MIN_ORGANIC_SCORE: '' });
    expect(ov.filters).toEqual({ minJupOrganicScore: null });
  });

  it('ignored-tokens csv is trimmed and blanks dropped', () => {
    expect(envEffectiveOverride({ COPYBOT_FILTER_IGNORED_TOKENS: ' A , ,B ' }).filters).toEqual({ ignoredTokens: ['A', 'B'] });
  });

  it('execution tunables are sparse: only env-set finite numbers appear', () => {
    const ov = envEffectiveOverride({ SELL_SLIPPAGE_BPS: '300', RESHAPE_BIN_DEADBAND_SOL: '0.001' });
    expect(ov.execution).toEqual({ slippageBps: 300, reshapeBinDeadbandSol: 0.001 });
  });

  it('a non-finite execution env var is ignored (DB value stands, never NaN)', () => {
    // WHY: a typo must not poison a numeric tunable with NaN — fall through to the DB value.
    expect(envEffectiveOverride({ DUST_TOKEN_RAW: 'abc' }).execution).toBeUndefined();
  });

  it('no execution env → execution override absent', () => {
    expect(envEffectiveOverride({}).execution).toBeUndefined();
  });

  it('COPYBOT_RUG_SL toggles rug-SL only when set (so the bench can disable the price poll)', () => {
    expect(envEffectiveOverride({}).rugSl).toBeUndefined();
    expect(envEffectiveOverride({ COPYBOT_RUG_SL: 'false' }).rugSl).toEqual({ enabled: false });
    expect(envEffectiveOverride({ COPYBOT_RUG_SL: 'true' }).rugSl).toEqual({ enabled: true });
  });

  it('priority-fee override is sparse: tier and a finite cap appear only when set', () => {
    expect(envEffectiveOverride({}).priorityFee).toBeUndefined();
    expect(envEffectiveOverride({ COPYBOT_PRIORITY_FEE_TIER: 'high' }).priorityFee).toEqual({ tier: 'high' });
    expect(envEffectiveOverride({ COPYBOT_PRIORITY_FEE_MAX_CAP_SOL: '0.01' }).priorityFee).toEqual({ maxCapSol: 0.01 });
    expect(envEffectiveOverride({ COPYBOT_PRIORITY_FEE_TIER: 'low', COPYBOT_PRIORITY_FEE_MAX_CAP_SOL: '0.002' }).priorityFee).toEqual({ tier: 'low', maxCapSol: 0.002 });
  });

  it('a non-finite priority-fee cap is dropped (the DB cap stands, never NaN)', () => {
    // WHY: the cap is the hard cost bound — a typo must never poison it with NaN (which would defeat the clamp).
    expect(envEffectiveOverride({ COPYBOT_PRIORITY_FEE_MAX_CAP_SOL: 'oops' }).priorityFee).toBeUndefined();
  });
});
