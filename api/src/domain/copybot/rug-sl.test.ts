import { describe, expect, it } from 'vitest';
import { decideRugSl, type PricePoint, type RugSlConfig } from './rug-sl';

const CFG: RugSlConfig = { enabled: true, dropPercent: 40, windowSeconds: 60 };
const NOW = 1_000_000;
const at = (secAgo: number, price: number): PricePoint => ({ ts: NOW - secAgo * 1000, price });

describe('rug-sl · decideRugSl', () => {
  it('triggers on a ≥40% drop from the in-window high', () => {
    // high 1.0 at -30s, latest 0.55 (-45%) → rug.
    expect(decideRugSl([at(30, 1.0), at(0, 0.55)], CFG, NOW)).toBe(true);
  });

  it('does NOT trigger on a drop smaller than the threshold', () => {
    // high 1.0, latest 0.7 (−30%) < 40% → no rug.
    expect(decideRugSl([at(30, 1.0), at(0, 0.7)], CFG, NOW)).toBe(false);
  });

  it('ignores samples older than the window (the high outside 60s does not count)', () => {
    // The 1.0 high is 90s ago (out of window); within-window high is 0.6, latest 0.5 (−16%) → no rug.
    expect(decideRugSl([at(90, 1.0), at(40, 0.6), at(0, 0.5)], CFG, NOW)).toBe(false);
  });

  it('does not trigger while the price is rising (latest is the high)', () => {
    expect(decideRugSl([at(30, 0.5), at(0, 1.0)], CFG, NOW)).toBe(false);
  });

  it('needs at least two in-window samples (a single point cannot show a drop)', () => {
    expect(decideRugSl([at(0, 1.0)], CFG, NOW)).toBe(false);
    expect(decideRugSl([], CFG, NOW)).toBe(false);
  });

  it('is off when disabled, regardless of the drop', () => {
    expect(decideRugSl([at(30, 1.0), at(0, 0.1)], { ...CFG, enabled: false }, NOW)).toBe(false);
  });

  it('a non-positive dropPercent never triggers (misconfig guard, not "any non-high")', () => {
    expect(decideRugSl([at(30, 1.0), at(0, 0.99)], { ...CFG, dropPercent: 0 }, NOW)).toBe(false);
  });

  it('honors a custom threshold', () => {
    const cfg = { ...CFG, dropPercent: 20 };
    expect(decideRugSl([at(30, 1.0), at(0, 0.75)], cfg, NOW)).toBe(true); // −25% ≥ 20%
    expect(decideRugSl([at(30, 1.0), at(0, 0.85)], cfg, NOW)).toBe(false); // −15% < 20%
  });
});
