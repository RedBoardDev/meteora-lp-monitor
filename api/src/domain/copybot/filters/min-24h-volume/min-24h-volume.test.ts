import { describe, expect, it } from 'vitest';
import { type FilterContext, FILTERS_ALL_OFF } from '../filter';
import { min24hVolumeUsd } from './min-24h-volume';

const c = { nonSolMint: 'MINT', pool: 'POOL' };
const ctx = (volume24hUsd?: number): FilterContext => ({ openTokenMints: new Set(), volume24hUsd });
const on = (v: number) => ({ ...FILTERS_ALL_OFF, min24hVolumeUsd: v });

describe('min24hVolumeUsd — skip thin tokens (per-leader, cached, Jupiter v2 stats24h)', () => {
  it('off when null, on when set', () => {
    expect(min24hVolumeUsd.enabled(FILTERS_ALL_OFF)).toBe(false);
    expect(min24hVolumeUsd.enabled(on(1000))).toBe(true);
  });
  it('volume below threshold → skip below_min_24h_volume', () => {
    expect(min24hVolumeUsd.evaluate(on(1000), c, ctx(500))).toEqual({ action: 'skip', reason: 'below_min_24h_volume' });
  });
  it('volume ≥ threshold → pass', () => {
    expect(min24hVolumeUsd.evaluate(on(1000), c, ctx(50_000))).toEqual({ action: 'pass' });
  });
  it('unknown volume → skip min_24h_volume_unavailable', () => {
    expect(min24hVolumeUsd.evaluate(on(1000), c, ctx())).toEqual({ action: 'skip', reason: 'min_24h_volume_unavailable' });
  });
  it('meta: jupiter-token / cached / no numeric preset', () => {
    expect([min24hVolumeUsd.source, min24hVolumeUsd.speedClass, min24hVolumeUsd.safePreset]).toEqual(['jupiter-token', 'cached', null]);
  });
});
