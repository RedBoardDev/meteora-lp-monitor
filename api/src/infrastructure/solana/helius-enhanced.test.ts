import { SOL_MINT } from '@binsight/shared';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accumulatePositionFlow,
  type EnhancedTx,
  HeliusEnhancedGateway,
  parseSwapBuy,
  parseSwapSell,
} from './helius-enhanced';

const silentLogger = { info() {}, warn() {}, debug() {} } as unknown as Logger;

const W = 'WALLET';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOK = 'TOKENmint';
const tt = (mint: string, from: string, to: string, amt: number) => ({
  mint,
  fromUserAccount: from,
  toUserAccount: to,
  tokenAmount: amt,
});

describe('parseSwapSell — clean token→SOL sell extraction (all NET)', () => {
  it('parses a simple sell: token out, WSOL in', () => {
    const tx = {
      timestamp: 100,
      signature: 's',
      type: 'SWAP',
      tokenTransfers: [tt(TOK, W, 'pool', 1000), tt(SOL_MINT, 'pool', W, 9)],
    } as unknown as EnhancedTx;
    const s = parseSwapSell(tx, W)!;
    expect(s.mint).toBe(TOK);
    expect(s.tokenAmount).toBe(1000);
    expect(s.solReceived).toBe(9);
  });

  it('nets a WSOL routing round-trip (gross inflow would over-count proceeds)', () => {
    // wallet receives 0.5 WSOL but sends 0.127 back into the route → real proceeds = 0.373
    const tx = {
      timestamp: 100,
      signature: 's',
      type: 'SWAP',
      tokenTransfers: [
        tt(TOK, W, 'p', 1000),
        tt(SOL_MINT, 'p', W, 0.5),
        tt(SOL_MINT, W, 'p', 0.127),
      ],
    } as unknown as EnhancedTx;
    const s = parseSwapSell(tx, W)!;
    expect(s.solReceived).toBeCloseTo(0.373, 9);
  });

  it('captures a route whose USDC intermediate TRANSITS the wallet ATA (the B2 bug)', () => {
    // Jotchua → USDC → WSOL: USDC is received then sent onward (out==back, nets to 0). The sold mint
    // is TOK only; the swap must NOT be dropped as "2 out-mints".
    const tx = {
      timestamp: 100,
      signature: 's',
      type: 'SWAP',
      tokenTransfers: [
        tt(TOK, W, 'p1', 176032),
        tt(USDC, 'p1', W, 109.04),
        tt(USDC, W, 'p2', 109.04), // transit: out == back → net 0
        tt(SOL_MINT, 'p2', W, 7.05),
      ],
    } as unknown as EnhancedTx;
    const s = parseSwapSell(tx, W)!;
    expect(s.mint).toBe(TOK);
    expect(s.tokenAmount).toBe(176032);
    expect(s.solReceived).toBeCloseTo(7.05, 9);
  });

  it('returns null for a GENUINE 2-token batched sell (unattributable)', () => {
    const tx = {
      timestamp: 100,
      signature: 's',
      type: 'SWAP',
      tokenTransfers: [tt(TOK, W, 'p', 1000), tt('OTHER', W, 'p', 500), tt(SOL_MINT, 'p', W, 9)],
    } as unknown as EnhancedTx;
    expect(parseSwapSell(tx, W)).toBeNull();
  });

  it('falls back to net native SOL when proceeds are unwrapped', () => {
    const tx = {
      timestamp: 100,
      signature: 's',
      type: 'SWAP',
      tokenTransfers: [tt(TOK, W, 'p', 1000)],
      nativeTransfers: [{ fromUserAccount: 'p', toUserAccount: W, amount: 8_000_000_000 }],
    } as unknown as EnhancedTx;
    const s = parseSwapSell(tx, W)!;
    expect(s.solReceived).toBeCloseTo(8, 9);
  });
});

describe('parseSwapBuy — clean SOL→token buy extraction, mirror of parseSwapSell (all NET)', () => {
  it('parses a simple buy: WSOL out, token in (solReceived = SOL spent)', () => {
    const tx = {
      timestamp: 100,
      signature: 's',
      type: 'SWAP',
      tokenTransfers: [tt(SOL_MINT, W, 'pool', 9), tt(TOK, 'pool', W, 1000)],
    } as unknown as EnhancedTx;
    const b = parseSwapBuy(tx, W)!;
    expect(b.mint).toBe(TOK);
    expect(b.tokenAmount).toBe(1000);
    expect(b.solReceived).toBe(9); // = SOL spent
  });

  it('nets a WSOL routing round-trip (gross outflow would over-count the cost)', () => {
    // wallet sends 0.5 WSOL but gets 0.127 back from the route → real cost = 0.373
    const tx = {
      timestamp: 100,
      signature: 's',
      type: 'SWAP',
      tokenTransfers: [
        tt(TOK, 'p', W, 1000),
        tt(SOL_MINT, W, 'p', 0.5),
        tt(SOL_MINT, 'p', W, 0.127),
      ],
    } as unknown as EnhancedTx;
    expect(parseSwapBuy(tx, W)!.solReceived).toBeCloseTo(0.373, 9);
  });

  it('captures a route whose USDC intermediate TRANSITS the wallet ATA', () => {
    const tx = {
      timestamp: 100,
      signature: 's',
      type: 'SWAP',
      tokenTransfers: [
        tt(TOK, 'p1', W, 176032),
        tt(USDC, 'p1', W, 109.04),
        tt(USDC, W, 'p2', 109.04), // transit: in == back → net 0
        tt(SOL_MINT, W, 'p2', 7.05),
      ],
    } as unknown as EnhancedTx;
    const b = parseSwapBuy(tx, W)!;
    expect(b.mint).toBe(TOK);
    expect(b.tokenAmount).toBe(176032);
    expect(b.solReceived).toBeCloseTo(7.05, 9);
  });

  it('returns null for a GENUINE 2-token batched buy (unattributable)', () => {
    const tx = {
      timestamp: 100,
      signature: 's',
      type: 'SWAP',
      tokenTransfers: [tt(TOK, 'p', W, 1000), tt('OTHER', 'p', W, 500), tt(SOL_MINT, W, 'p', 9)],
    } as unknown as EnhancedTx;
    expect(parseSwapBuy(tx, W)).toBeNull();
  });

  it('falls back to net native SOL when the cost is paid unwrapped', () => {
    const tx = {
      timestamp: 100,
      signature: 's',
      type: 'SWAP',
      tokenTransfers: [tt(TOK, 'p', W, 1000)],
      nativeTransfers: [{ fromUserAccount: W, toUserAccount: 'p', amount: 8_000_000_000 }],
    } as unknown as EnhancedTx;
    expect(parseSwapBuy(tx, W)!.solReceived).toBeCloseTo(8, 9);
  });
});

const ad = (account: string, nbc: number, tbc: unknown[] = []) => ({
  account,
  nativeBalanceChange: nbc,
  tokenBalanceChanges: tbc,
});

describe('accumulatePositionFlow — on-chain SOL-leg + NET residual', () => {
  it('sums native deposits/withdrawals and the residual received', () => {
    const deposit = { accountData: [ad(W, -5_000_000_000)] } as unknown as EnhancedTx;
    const close = {
      accountData: [ad(W, 3_000_000_000)],
      tokenTransfers: [tt(TOK, 'pool', W, 1000)],
    } as unknown as EnhancedTx;
    const f = accumulatePositionFlow([deposit, close], W, TOK);
    expect(f.solLegSol).toBeCloseTo(-2, 9); // deposited 5, withdrew 3 SOL
    expect(f.residualAmount).toBe(1000);
  });

  it('NETs the residual across add/remove cycles (gross-received would over-count)', () => {
    // wallet adds 500 TOK (sent), removes 1500 TOK (received) → net residual = 1000
    const t = {
      accountData: [ad(W, 0)],
      tokenTransfers: [tt(TOK, W, 'pool', 500), tt(TOK, 'pool', W, 1500)],
    } as unknown as EnhancedTx;
    const f = accumulatePositionFlow([t], W, TOK);
    expect(f.residualAmount).toBe(1000);
  });

  it('counts the SOL-side withdrawn as WSOL via tokenBalanceChanges', () => {
    const close = {
      accountData: [
        ad(W, 0, [
          {
            userAccount: W,
            mint: SOL_MINT,
            rawTokenAmount: { tokenAmount: '4000000000', decimals: 9 },
          },
        ]),
      ],
    } as unknown as EnhancedTx;
    const f = accumulatePositionFlow([close], W, TOK);
    expect(f.solLegSol).toBeCloseTo(4, 9); // 4 WSOL credited
  });
});

describe('HeliusEnhancedGateway — Enhanced API call telemetry (stats)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('counts every Enhanced page fetch under its call-site — the getEnhancedTransactionsByAddress budget', async () => {
    // WHY this exists: these REST calls BYPASS the JSON-RPC rate-limiter's counters, so the single most
    // expensive RPC consumer (a full-history re-page = #pages billed requests) was invisible in telemetry.
    const gw = new HeliusEnhancedGateway('https://rpc.test/?api-key=k', silentLogger);
    const page = [
      {
        timestamp: 100,
        signature: 's',
        type: 'SWAP',
        tokenTransfers: [tt(TOK, W, 'pool', 1000), tt(SOL_MINT, 'pool', W, 9)],
      },
    ];
    // one data page, then an empty page (genuine end of history) → exactly 2 billed requests
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);

    const res = await gw.fetchSells(W, 0);
    expect(res.sells.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(gw.stats()).toMatchObject({ total: 2, sells: 2, buys: 0, walletFlows: 0, pageFlows: 0 });
  });

  it('attributes a retried page to the same call-site (Helius bills each retry, not each logical page)', async () => {
    const gw = new HeliusEnhancedGateway('https://rpc.test/?api-key=k', silentLogger);
    // attempt 1: transient 500 (retried); attempt 2: empty page (end) → 2 billed requests, ONE logical page
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, headers: { get: () => null } })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);

    await gw.fetchBuys(W, 0);
    expect(gw.stats()).toMatchObject({ total: 2, buys: 2, sells: 0 });
  });
});
