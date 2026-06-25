import { describe, expect, it } from 'vitest';
import { type HttpFetch, WSOL_MINT, buildJupiterSwapTx, getJupiterBuyQuote, getJupiterQuote } from './jupiter-swap-builder';

const BASE = 'https://jup.test/v6';
const MINT = 'TokenMintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

// A capturing fake fetch: records the calls and returns a canned response.
function fakeFetch(response: { ok?: boolean; status?: number; body: unknown }): { fetch: HttpFetch; calls: Array<{ url: string; init?: unknown }> } {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: response.ok ?? true, status: response.status ?? 200, json: async () => response.body };
  };
  return { fetch, calls };
}

// A fake fetch that returns a SEQUENCE of responses (one per call) — to drive the retry/backoff path.
function seqFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>): { fetch: HttpFetch; count: () => number } {
  let i = 0;
  const fetch: HttpFetch = async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: r?.ok ?? true, status: r?.status ?? 200, json: async () => r?.body };
  };
  return { fetch, count: () => i };
}

describe('getJupiterQuote', () => {
  it('builds the quote URL (output=WSOL, amount, slippage, legacy) and parses out/in amounts', async () => {
    const { fetch, calls } = fakeFetch({ body: { inAmount: '1000', outAmount: '995', otherJupField: 1 } });
    const q = await getJupiterQuote(BASE, MINT, 1000n, 50, fetch);
    expect(q).toMatchObject({ inputMint: MINT, outputMint: WSOL_MINT, inAmount: '1000', outAmount: '995' });
    expect(calls[0]?.url).toContain(`inputMint=${MINT}`);
    expect(calls[0]?.url).toContain(`outputMint=${WSOL_MINT}`);
    expect(calls[0]?.url).toContain('amount=1000');
    expect(calls[0]?.url).toContain('slippageBps=50');
    expect(calls[0]?.url).toContain('asLegacyTransaction=true');
  });

  it('keeps the full quote object in raw (forwarded verbatim to /swap)', async () => {
    const body = { inAmount: '1', outAmount: '1', routePlan: [{ x: 1 }] };
    const q = await getJupiterQuote(BASE, MINT, 1n, 50, fakeFetch({ body }).fetch);
    expect(q.raw).toEqual(body);
  });

  it('throws immediately on a permanent 4xx (e.g. 400 no route) — no pointless retry', async () => {
    const { fetch } = fakeFetch({ ok: false, status: 400, body: {} });
    await expect(getJupiterQuote(BASE, MINT, 1n, 50, fetch)).rejects.toThrow('400');
  });

  it('RETRIES a transient 429 then succeeds (rate-limit resilience)', async () => {
    const { fetch, count } = seqFetch([
      { ok: false, status: 429, body: {} },
      { body: { inAmount: '10', outAmount: '9' } },
    ]);
    const q = await getJupiterQuote(BASE, MINT, 10n, 50, fetch);
    expect(q.outAmount).toBe('9');
    expect(count()).toBe(2); // retried once
  });

  it('throws when the response is missing outAmount (no route)', async () => {
    const { fetch } = fakeFetch({ body: { inAmount: '1' } });
    await expect(getJupiterQuote(BASE, MINT, 1n, 50, fetch)).rejects.toThrow();
  });
});

describe('getJupiterBuyQuote — ExactOut SOL→token (two-sided copy)', () => {
  it('builds an ExactOut URL (input=WSOL, output=token, swapMode=ExactOut) for the exact token amount', async () => {
    const { fetch, calls } = fakeFetch({ body: { inAmount: '2010', outAmount: '5000', k: 1 } });
    const q = await getJupiterBuyQuote(BASE, MINT, 5000n, 50, fetch);
    expect(q).toMatchObject({ inputMint: WSOL_MINT, outputMint: MINT, inAmount: '2010', outAmount: '5000' });
    expect(calls[0]?.url).toContain(`inputMint=${WSOL_MINT}`);
    expect(calls[0]?.url).toContain(`outputMint=${MINT}`);
    expect(calls[0]?.url).toContain('amount=5000');
    expect(calls[0]?.url).toContain('swapMode=ExactOut');
    expect(calls[0]?.url).toContain('asLegacyTransaction=true');
  });

  it('throws immediately on a permanent 4xx (400)', async () => {
    const { fetch } = fakeFetch({ ok: false, status: 400, body: {} });
    await expect(getJupiterBuyQuote(BASE, MINT, 1n, 50, fetch)).rejects.toThrow('400');
  });

  it('throws when the response is missing outAmount (no route to buy)', async () => {
    const { fetch } = fakeFetch({ body: { inAmount: '1' } });
    await expect(getJupiterBuyQuote(BASE, MINT, 1n, 50, fetch)).rejects.toThrow();
  });
});

describe('buildJupiterSwapTx', () => {
  const quote = { inputMint: MINT, outputMint: WSOL_MINT, inAmount: '1000', outAmount: '995', raw: { outAmount: '995', k: 1 } };

  it('POSTs the quote + user and returns the base64 swap transaction', async () => {
    const { fetch, calls } = fakeFetch({ body: { swapTransaction: 'BASE64TX' } });
    const tx = await buildJupiterSwapTx(BASE, quote, 'OWNER', fetch);
    expect(tx).toBe('BASE64TX');
    expect(calls[0]?.url).toBe(`${BASE}/swap`);
    const body = JSON.parse((calls[0]?.init as { body: string }).body);
    expect(body).toMatchObject({ userPublicKey: 'OWNER', asLegacyTransaction: true, wrapAndUnwrapSol: true });
    expect(body.quoteResponse).toEqual(quote.raw);
  });

  it('throws immediately on a permanent 4xx (400)', async () => {
    const { fetch } = fakeFetch({ ok: false, status: 400, body: {} });
    await expect(buildJupiterSwapTx(BASE, quote, 'OWNER', fetch)).rejects.toThrow('400');
  });

  it('RETRIES a transient 503 then succeeds', async () => {
    const { fetch, count } = seqFetch([
      { ok: false, status: 503, body: {} },
      { body: { swapTransaction: 'BASE64TX' } },
    ]);
    expect(await buildJupiterSwapTx(BASE, quote, 'OWNER', fetch)).toBe('BASE64TX');
    expect(count()).toBe(2);
  });

  it('throws when the response carries no swapTransaction', async () => {
    const { fetch } = fakeFetch({ body: { error: 'nope' } });
    await expect(buildJupiterSwapTx(BASE, quote, 'OWNER', fetch)).rejects.toThrow();
  });
});
