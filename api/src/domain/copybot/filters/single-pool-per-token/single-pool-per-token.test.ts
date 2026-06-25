import { describe, expect, it } from 'vitest';
import { FILTERS_ALL_OFF } from '../filter';
import { singlePoolPerToken } from './single-pool-per-token';

const c = (mint: string | null) => ({ nonSolMint: mint, pool: 'POOL' });
const cfgOn = { ...FILTERS_ALL_OFF, singlePoolPerToken: true };

describe('singlePoolPerToken — ≤1 live position per token (per-leader, instant, local)', () => {
  it('off by default, on when toggled', () => {
    expect(singlePoolPerToken.enabled(FILTERS_ALL_OFF)).toBe(false);
    expect(singlePoolPerToken.enabled(cfgOn)).toBe(true);
  });
  it('token already held open → skip single_pool_per_token', () => {
    expect(singlePoolPerToken.evaluate(cfgOn, c('MINT'), { openTokenMints: new Set(['MINT']) })).toEqual({ action: 'skip', reason: 'single_pool_per_token' });
  });
  it('token not held → pass', () => {
    expect(singlePoolPerToken.evaluate(cfgOn, c('MINT'), { openTokenMints: new Set(['OTHER']) })).toEqual({ action: 'pass' });
  });
  it('null mint → pass', () => {
    expect(singlePoolPerToken.evaluate(cfgOn, c(null), { openTokenMints: new Set(['MINT']) })).toEqual({ action: 'pass' });
  });
  it('meta: per-leader / local / instant / preset ON', () => {
    expect([singlePoolPerToken.scope, singlePoolPerToken.source, singlePoolPerToken.speedClass, singlePoolPerToken.safePreset]).toEqual(['per-leader', 'local', 'instant', true]);
  });
});
