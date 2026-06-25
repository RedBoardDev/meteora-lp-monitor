import { describe, expect, it } from 'vitest';
import { type FilterContext, FILTERS_ALL_OFF } from '../filter';
import { minJupOrganicScore } from './min-jup-organic-score';

const c = { nonSolMint: 'MINT', pool: 'POOL' };
const ctx = (organicScore?: number): FilterContext => ({ openTokenMints: new Set(), organicScore });
const on = (v: number) => ({ ...FILTERS_ALL_OFF, minJupOrganicScore: v });

describe('minJupOrganicScore — primary anti-rug signal (per-leader, external-call, Jupiter v2)', () => {
  it('off when null, on when set', () => {
    expect(minJupOrganicScore.enabled(FILTERS_ALL_OFF)).toBe(false);
    expect(minJupOrganicScore.enabled(on(50))).toBe(true);
  });
  it('score below threshold → skip below_min_organic_score', () => {
    expect(minJupOrganicScore.evaluate(on(50), c, ctx(40))).toEqual({ action: 'skip', reason: 'below_min_organic_score' });
  });
  it('score ≥ threshold → pass', () => {
    expect(minJupOrganicScore.evaluate(on(50), c, ctx(80))).toEqual({ action: 'pass' });
  });
  it('unknown score → skip min_organic_score_unavailable (no open without the score)', () => {
    expect(minJupOrganicScore.evaluate(on(50), c, ctx())).toEqual({ action: 'skip', reason: 'min_organic_score_unavailable' });
  });
  it('meta: jupiter-token / external-call / preset 50', () => {
    expect([minJupOrganicScore.source, minJupOrganicScore.speedClass, minJupOrganicScore.safePreset]).toEqual(['jupiter-token', 'external-call', 50]);
  });
});
