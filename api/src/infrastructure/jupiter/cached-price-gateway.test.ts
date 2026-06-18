import { describe, expect, it } from 'vitest';
import type { PriceGateway } from '@/domain/ports';
import { CachedPriceGateway } from './cached-price-gateway';

class FakeInner implements PriceGateway {
  calls = 0;
  async getPricesSol(mints: string[]): Promise<Map<string, number>> {
    this.calls++;
    await new Promise((r) => setTimeout(r, 5));
    return new Map(mints.map((m) => [m, 1]));
  }
  async getSolUsd(): Promise<number | null> {
    this.calls++;
    await new Promise((r) => setTimeout(r, 5));
    return 100;
  }
}

describe('CachedPriceGateway', () => {
  it('coalesces concurrent requests for the same mint into ONE upstream call', async () => {
    const inner = new FakeInner();
    const g = new CachedPriceGateway(inner, { priceTtlMs: 10_000 });
    const [a, b] = await Promise.all([g.getPricesSol(['M']), g.getPricesSol(['M'])]);
    expect(inner.calls).toBe(1);
    expect(a.get('M')).toBe(1);
    expect(b.get('M')).toBe(1);
  });

  it('serves cached prices within the TTL without a new upstream call', async () => {
    const inner = new FakeInner();
    const g = new CachedPriceGateway(inner, { priceTtlMs: 10_000 });
    await g.getPricesSol(['M']);
    await g.getPricesSol(['M']);
    expect(inner.calls).toBe(1);
  });

  it('caches and coalesces getSolUsd', async () => {
    const inner = new FakeInner();
    const g = new CachedPriceGateway(inner, { solUsdTtlMs: 10_000 });
    const [a, b] = await Promise.all([g.getSolUsd(), g.getSolUsd()]);
    expect(inner.calls).toBe(1);
    expect(a).toBe(100);
    expect(b).toBe(100);
    expect(await g.getSolUsd()).toBe(100);
    expect(inner.calls).toBe(1);
  });
});
