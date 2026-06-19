import { SOL_MINT } from '@binsight/shared';
import { describe, expect, it } from 'vitest';
import { accumulatePositionFlow, type EnhancedTx, parseSwapSell } from './helius-enhanced';

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
