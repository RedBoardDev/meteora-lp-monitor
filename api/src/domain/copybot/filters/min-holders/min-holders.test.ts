import { describe, expect, it } from 'vitest';
import { type FilterContext, FILTERS_ALL_OFF } from '../filter';
import { minHolders } from './min-holders';

const c = { nonSolMint: 'MINT', pool: 'POOL' };
const ctx = (holders?: number): FilterContext => ({ openTokenMints: new Set(), holders });
const on = (v: number) => ({ ...FILTERS_ALL_OFF, minHolders: v });

describe('minHolders — concentration proxy (per-leader, external-call, Jupiter v2 holderCount — now free)', () => {
  it('off when null, on when set', () => {
    expect(minHolders.enabled(FILTERS_ALL_OFF)).toBe(false);
    expect(minHolders.enabled(on(100))).toBe(true);
  });
  it('holders below threshold → skip below_min_holders', () => {
    expect(minHolders.evaluate(on(100), c, ctx(50))).toEqual({ action: 'skip', reason: 'below_min_holders' });
  });
  it('holders ≥ threshold → pass', () => {
    expect(minHolders.evaluate(on(100), c, ctx(500))).toEqual({ action: 'pass' });
  });
  it('unknown holders → skip min_holders_unavailable', () => {
    expect(minHolders.evaluate(on(100), c, ctx())).toEqual({ action: 'skip', reason: 'min_holders_unavailable' });
  });
  it('meta: jupiter-token / external-call / no numeric preset', () => {
    expect([minHolders.source, minHolders.speedClass, minHolders.safePreset]).toEqual(['jupiter-token', 'external-call', null]);
  });
});
