import { afterEach, describe, expect, it, vi } from 'vitest';
import { JupiterTokenGateway } from './jupiter-token-gateway';

const MINT = 'TokenMint1111111111111111111111111111111111';
const CREATED_AT = '2026-06-20T00:00:00.000Z';

const fullToken = {
  id: MINT,
  organicScore: 72,
  holderCount: 1234,
  mcap: 2_500_000,
  firstPool: { createdAt: CREATED_AT },
  stats24h: { priceChange: 12.5, buyVolume: 30_000, sellVolume: 20_000 },
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 14.2 },
  someUnknownFutureField: 'ignored',
};

const mockFetch = (impl: typeof fetch) => vi.stubGlobal('fetch', vi.fn(impl));
const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe('JupiterTokenGateway — Jupiter v2 search → normalized snapshot (one call, all fields)', () => {
  it('maps the matching token (volume = buy + sell; age fields from firstPool; passthrough tolerated)', async () => {
    mockFetch(json([fullToken]));
    const snap = await new JupiterTokenGateway().getSnapshot(MINT);
    expect(snap).toEqual({
      organicScore: 72,
      holders: 1234,
      marketCapUsd: 2_500_000,
      volume24hUsd: 50_000,
      priceChange24hPercent: 12.5,
      firstPoolCreatedAtMs: Date.parse(CREATED_AT),
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercent: 14.2,
    });
  });

  it('unknown mint (no entry matches the query) → null', async () => {
    mockFetch(json([{ id: 'OTHER', organicScore: 9 }]));
    expect(await new JupiterTokenGateway().getSnapshot(MINT)).toBeNull();
  });

  it('missing optional fields → all nulls (never throws on a sparse token)', async () => {
    mockFetch(json([{ id: MINT }]));
    expect(await new JupiterTokenGateway().getSnapshot(MINT)).toEqual({
      organicScore: null,
      holders: null,
      marketCapUsd: null,
      volume24hUsd: null,
      priceChange24hPercent: null,
      firstPoolCreatedAtMs: null,
      mintAuthorityDisabled: null,
      freezeAuthorityDisabled: null,
      topHoldersPercent: null,
    });
  });

  it('non-OK response → null + onError called (best-effort, never throws)', async () => {
    const onError = vi.fn();
    mockFetch(json('nope', 500));
    expect(await new JupiterTokenGateway({ onError }).getSnapshot(MINT)).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), MINT);
  });

  it('network error → null', async () => {
    mockFetch(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await new JupiterTokenGateway().getSnapshot(MINT)).toBeNull();
  });

  it('passes the x-api-key header only when an apiKey is configured', async () => {
    const spy = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify([fullToken]), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await new JupiterTokenGateway({ apiKey: 'KEY' }).getSnapshot(MINT);
    const headers = spy.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.['x-api-key']).toBe('KEY');
  });
});
