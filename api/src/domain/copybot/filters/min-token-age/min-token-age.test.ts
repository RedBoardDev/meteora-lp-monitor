import { describe, expect, it } from 'vitest';
import { type FilterContext, FILTERS_ALL_OFF } from '../filter';
import { minTokenAgeHours } from './min-token-age';

const c = { nonSolMint: 'MINT', pool: 'POOL' };
const ctx = (tokenAgeHours?: number): FilterContext => ({ openTokenMints: new Set(), tokenAgeHours });
const on = (v: number) => ({ ...FILTERS_ALL_OFF, minTokenAgeHours: v });

describe('minTokenAgeHours — skip young tokens (per-leader, cached, Jupiter v2 firstPool)', () => {
  it('off when null, on when set', () => {
    expect(minTokenAgeHours.enabled(FILTERS_ALL_OFF)).toBe(false);
    expect(minTokenAgeHours.enabled(on(2))).toBe(true);
  });
  it('age below threshold → skip below_min_token_age', () => {
    expect(minTokenAgeHours.evaluate(on(2), c, ctx(1))).toEqual({ action: 'skip', reason: 'below_min_token_age' });
  });
  it('age ≥ threshold → pass', () => {
    expect(minTokenAgeHours.evaluate(on(2), c, ctx(10))).toEqual({ action: 'pass' });
  });
  it('unknown age → skip min_token_age_unavailable (no open on unverifiable data)', () => {
    expect(minTokenAgeHours.evaluate(on(2), c, ctx())).toEqual({ action: 'skip', reason: 'min_token_age_unavailable' });
  });
  it('meta: jupiter-token / cached / preset 2', () => {
    expect([minTokenAgeHours.source, minTokenAgeHours.speedClass, minTokenAgeHours.safePreset]).toEqual(['jupiter-token', 'cached', 2]);
  });
});
