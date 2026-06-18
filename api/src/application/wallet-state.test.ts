import type { OpenPosition } from '@meteora/shared';
import { describe, expect, it } from 'vitest';
import type { OnchainValued } from '@/domain/dlmm';
import { buildTotals, buildWalletState, combineOnchain } from './wallet-state';

const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  positionAddress: 'p',
  wallet: 'w',
  poolAddress: 'pool',
  tokenX: 'X',
  tokenY: 'SOL',
  tokenXMint: 'm',
  strategy: null,
  sizeSol: 10,
  pnlSol: 1,
  pnlPctSol: 10,
  claimedFeesSol: 0.1,
  unclaimedFeesSol: 0.2,
  rangeStatus: 'in',
  minPrice: 1,
  maxPrice: 2,
  poolPrice: 1.5,
  outOfRangeSince: null,
  openedAt: null,
  updatedAt: 0,
  ...over,
});

describe('buildTotals', () => {
  it('sums TVL/PnL/fees and counts in vs out of range', () => {
    const t = buildTotals([pos(), pos({ rangeStatus: 'out_up', pnlSol: -2 })], 5);
    expect(t.tvlSol).toBe(20);
    expect(t.uPnlSol).toBe(-1);
    expect(t.inRangeCount).toBe(1);
    expect(t.outOfRangeCount).toBe(1);
    expect(t.openCount).toBe(2);
  });

  it('walletTotalSol = TVL + idle', () => {
    const t = buildTotals([pos({ sizeSol: 10 })], 7.5);
    expect(t.idleSol).toBe(7.5);
    expect(t.walletTotalSol).toBe(17.5);
  });

  it('empty portfolio yields zeros, no divide-by-zero', () => {
    const t = buildTotals([], 0);
    expect(t.openCount).toBe(0);
    expect(t.uPnlPct).toBe(0);
    expect(t.walletTotalSol).toBe(0);
  });
});

const onchain = (over: Partial<OnchainValued> = {}): OnchainValued => ({
  slot: 1,
  slotSkew: 0,
  tvlSol: 0,
  idleSol: 0,
  unclaimedFeesSol: 0,
  lockedRentSol: 0,
  walletTotalSol: 0,
  positionCount: 0,
  sizeSolByPosition: new Map(),
  feeSolByPosition: new Map(),
  ...over,
});

describe('buildWalletState (on-chain authoritative total)', () => {
  // The historic bug: walletTotal = tvl(Meteora, lagging) + idle(RPC, lagging) double-counted capital
  // in flight. The total must now come from the single-slot on-chain snapshot, NOT from re-summing
  // a possibly-stale position list plus a separately-clocked idle figure.
  it('takes walletTotal from the on-chain snapshot, immune to a stale Meteora position list', () => {
    // Meteora still shows a 44-SOL position whose capital actually already moved; on-chain (one slot)
    // says the wallet is worth 44 total. The old path would have shown 44 (tvl) + 44 (stale idle) = 88.
    const oc = onchain({
      tvlSol: 0,
      idleSol: 44,
      walletTotalSol: 44,
      sizeSolByPosition: new Map([['p', 0]]),
      feeSolByPosition: new Map([['p', 0]]),
    });
    const s = buildWalletState('w', [pos({ positionAddress: 'p', sizeSol: 44 })], oc);
    expect(s.totals.walletTotalSol).toBe(44);
    expect(s.totals.tvlSol).toBe(0); // authoritative on-chain tvl, not the stale 44 from Meteora
    expect(s.openPositions[0]?.sizeSol).toBe(0); // per-position value overridden from on-chain
  });

  it('walletTotal includes idle + fees + rent ("tout inclus")', () => {
    const oc = onchain({
      tvlSol: 30,
      idleSol: 10,
      unclaimedFeesSol: 2,
      lockedRentSol: 1,
      walletTotalSol: 43,
    });
    const s = buildWalletState('w', [pos({ sizeSol: 30 })], oc);
    expect(s.totals.walletTotalSol).toBe(43);
    expect(s.totals.idleSol).toBe(10);
  });

  it('keeps PnL from the Meteora positions (deposit basis the chain cannot supply)', () => {
    const oc = onchain({ tvlSol: 12, walletTotalSol: 12, sizeSolByPosition: new Map([['p', 12]]) });
    const s = buildWalletState('w', [pos({ positionAddress: 'p', sizeSol: 10, pnlSol: 3 })], oc);
    expect(s.totals.uPnlSol).toBe(3);
    expect(s.openPositions[0]?.sizeSol).toBe(12); // value from on-chain
  });

  it('falls back to tvl+idle before the first snapshot lands', () => {
    const s = buildWalletState('w', [pos({ sizeSol: 10 })], null);
    expect(s.totals.walletTotalSol).toBe(10);
    expect(s.asOfSlot).toBeNull();
    expect(s.freshness).toBe('syncing');
  });

  it('reports asOfSlot + freshness=fresh for a clean single-slot snapshot', () => {
    const s = buildWalletState('w', [pos()], onchain({ slot: 999, slotSkew: 0 }));
    expect(s.asOfSlot).toBe(999);
    expect(s.freshness).toBe('fresh');
  });

  it('marks freshness=syncing when the snapshot spans many slots (large wallet)', () => {
    expect(buildWalletState('w', [pos()], onchain({ slot: 1000, slotSkew: 40 })).freshness).toBe(
      'syncing',
    );
  });
});

describe('combineOnchain', () => {
  it('sums scalar totals and merges position maps across wallets', () => {
    const a = onchain({
      tvlSol: 10,
      idleSol: 5,
      walletTotalSol: 15,
      positionCount: 1,
      sizeSolByPosition: new Map([['a', 10]]),
    });
    const b = onchain({
      tvlSol: 20,
      idleSol: 0,
      walletTotalSol: 20,
      positionCount: 2,
      sizeSolByPosition: new Map([['b', 20]]),
    });
    const c = combineOnchain([a, b]);
    expect(c?.walletTotalSol).toBe(35);
    expect(c?.tvlSol).toBe(30);
    expect(c?.positionCount).toBe(3);
    expect(c?.sizeSolByPosition.get('b')).toBe(20);
  });

  it('returns null when no wallet has a snapshot yet', () => {
    expect(combineOnchain([])).toBeNull();
  });
});
